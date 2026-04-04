import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import {
  Activation,
  DeliveryAttempt,
  InboxItem,
  Interest,
  SubscriptionSource,
} from "./model";

function parseJson<T>(value: string | null): T {
  if (!value) {
    return {} as T;
  }
  return JSON.parse(value) as T;
}

export class AgentInboxStore {
  private static sqlPromise: Promise<SqlJsStatic> | null = null;

  private constructor(
    private readonly dbPath: string,
    private readonly db: Database,
  ) {}

  static async open(dbPath: string): Promise<AgentInboxStore> {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const SQL = await this.loadSqlJs();
    const db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();
    const store = new AgentInboxStore(dbPath, db);
    store.migrate();
    store.persist();
    return store;
  }

  private static async loadSqlJs(): Promise<SqlJsStatic> {
    if (!this.sqlPromise) {
      this.sqlPromise = initSqlJs({
        locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
      });
    }
    return this.sqlPromise;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sources (
        source_id text primary key,
        source_type text not null,
        source_key text not null,
        config_ref text,
        config_json text not null,
        status text not null,
        checkpoint text,
        created_at text not null,
        updated_at text not null,
        unique(source_type, source_key)
      );

      create table if not exists interests (
        interest_id text primary key,
        agent_id text not null,
        source_id text not null,
        mailbox_id text not null,
        match_rules_json text not null,
        activation_target text,
        created_at text not null
      );

      create table if not exists inbox_items (
        item_id text primary key,
        source_id text not null,
        source_native_id text not null,
        event_variant text not null,
        mailbox_id text not null,
        occurred_at text not null,
        metadata_json text not null,
        raw_payload_json text not null,
        delivery_handle_json text,
        acked_at text,
        unique(source_id, source_native_id, event_variant, mailbox_id)
      );

      create table if not exists activations (
        activation_id text primary key,
        agent_id text not null,
        mailbox_id text not null,
        new_item_count integer not null,
        summary text not null,
        created_at text not null,
        delivered_at text
      );

      create table if not exists deliveries (
        delivery_id text primary key,
        provider text not null,
        surface text not null,
        target_ref text not null,
        thread_ref text,
        reply_mode text,
        kind text not null,
        payload_json text not null,
        status text not null,
        created_at text not null
      );
    `);
  }

  private persist(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    this.db.close();
  }

  getSourceByKey(sourceType: string, sourceKey: string): SubscriptionSource | null {
    const row = this.getOne("select * from sources where source_type = ? and source_key = ?", [sourceType, sourceKey]);
    return row ? this.mapSource(row) : null;
  }

  getSource(sourceId: string): SubscriptionSource | null {
    const row = this.getOne("select * from sources where source_id = ?", [sourceId]);
    return row ? this.mapSource(row) : null;
  }

  insertSource(source: SubscriptionSource): void {
    this.db.run(
      `
      insert into sources (
        source_id, source_type, source_key, config_ref, config_json,
        status, checkpoint, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        source.sourceId,
        source.sourceType,
        source.sourceKey,
        source.configRef ?? null,
        JSON.stringify(source.config ?? {}),
        source.status,
        source.checkpoint ?? null,
        source.createdAt,
        source.updatedAt,
      ],
    );
    this.persist();
  }

  listSources(): SubscriptionSource[] {
    const rows = this.getAll("select * from sources order by created_at asc");
    return rows.map((row) => this.mapSource(row));
  }

  insertInterest(interest: Interest): void {
    this.db.run(
      `
      insert into interests (
        interest_id, agent_id, source_id, mailbox_id, match_rules_json,
        activation_target, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        interest.interestId,
        interest.agentId,
        interest.sourceId,
        interest.mailboxId,
        JSON.stringify(interest.matchRules),
        interest.activationTarget ?? null,
        interest.createdAt,
      ],
    );
    this.persist();
  }

  listInterests(): Interest[] {
    const rows = this.getAll("select * from interests order by created_at asc");
    return rows.map((row) => this.mapInterest(row));
  }

  listInterestsForSource(sourceId: string): Interest[] {
    const rows = this.getAll("select * from interests where source_id = ? order by created_at asc", [sourceId]);
    return rows.map((row) => this.mapInterest(row));
  }

  insertInboxItem(item: InboxItem): boolean {
    const before = this.changes();
    this.db.run(
      `
      insert or ignore into inbox_items (
        item_id, source_id, source_native_id, event_variant, mailbox_id, occurred_at,
        metadata_json, raw_payload_json, delivery_handle_json, acked_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        item.itemId,
        item.sourceId,
        item.sourceNativeId,
        item.eventVariant,
        item.mailboxId,
        item.occurredAt,
        JSON.stringify(item.metadata),
        JSON.stringify(item.rawPayload),
        item.deliveryHandle ? JSON.stringify(item.deliveryHandle) : null,
        item.ackedAt ?? null,
      ],
    );
    const inserted = this.changes() > before;
    if (inserted) {
      this.persist();
    }
    return inserted;
  }

  listMailboxIds(): string[] {
    const rows = this.getAll("select distinct mailbox_id from inbox_items order by mailbox_id asc");
    return rows.map((row) => String(row.mailbox_id));
  }

  listInboxItems(mailboxId: string): InboxItem[] {
    const rows = this.getAll("select * from inbox_items where mailbox_id = ? order by occurred_at asc", [mailboxId]);
    return rows.map((row) => this.mapInboxItem(row));
  }

  ackItems(mailboxId: string, itemIds: string[], ackedAt: string): number {
    let changes = 0;
    for (const itemId of itemIds) {
      const before = this.changes();
      this.db.run(
        `
        update inbox_items set acked_at = ?
        where mailbox_id = ? and item_id = ? and acked_at is null
      `,
        [ackedAt, mailboxId, itemId],
      );
      const after = this.changes();
      changes += after - before;
    }
    if (changes > 0) {
      this.persist();
    }
    return changes;
  }

  insertActivation(activation: Activation): void {
    this.db.run(
      `
      insert into activations (
        activation_id, agent_id, mailbox_id, new_item_count, summary, created_at, delivered_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        activation.activationId,
        activation.agentId,
        activation.mailboxId,
        activation.newItemCount,
        activation.summary,
        activation.createdAt,
        activation.deliveredAt ?? null,
      ],
    );
    this.persist();
  }

  listActivations(): Activation[] {
    const rows = this.getAll("select * from activations order by created_at desc");
    return rows.map((row) => this.mapActivation(row));
  }

  insertDelivery(delivery: DeliveryAttempt): void {
    this.db.run(
      `
      insert into deliveries (
        delivery_id, provider, surface, target_ref, thread_ref, reply_mode,
        kind, payload_json, status, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        delivery.deliveryId,
        delivery.provider,
        delivery.surface,
        delivery.targetRef,
        delivery.threadRef ?? null,
        delivery.replyMode ?? null,
        delivery.kind,
        JSON.stringify(delivery.payload),
        delivery.status,
        delivery.createdAt,
      ],
    );
    this.persist();
  }

  listDeliveries(): DeliveryAttempt[] {
    const rows = this.getAll("select * from deliveries order by created_at desc");
    return rows.map((row) => this.mapDelivery(row));
  }

  getCounts(): Record<string, number> {
    const sources = this.count("sources");
    const interests = this.count("interests");
    const inboxItems = this.count("inbox_items");
    const pendingItems = this.count("inbox_items where acked_at is null");
    const activations = this.count("activations");
    const deliveries = this.count("deliveries");
    return { sources, interests, inboxItems, pendingItems, activations, deliveries };
  }

  private count(tableOrClause: string): number {
    const row = this.getOne(`select count(*) as count from ${tableOrClause}`);
    return row ? Number(row.count) : 0;
  }

  private changes(): number {
    const row = this.getOne("select changes() as count");
    return row ? Number(row.count) : 0;
  }

  private getOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      if (!statement.step()) {
        return undefined;
      }
      return statement.getAsObject() as Record<string, unknown>;
    } finally {
      statement.free();
    }
  }

  private getAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as Record<string, unknown>);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private mapSource(row: Record<string, unknown>): SubscriptionSource {
    return {
      sourceId: String(row.source_id),
      sourceType: row.source_type as SubscriptionSource["sourceType"],
      sourceKey: String(row.source_key),
      configRef: row.config_ref ? String(row.config_ref) : null,
      config: parseJson<Record<string, unknown>>(row.config_json as string),
      status: row.status as SubscriptionSource["status"],
      checkpoint: row.checkpoint ? String(row.checkpoint) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapInterest(row: Record<string, unknown>): Interest {
    return {
      interestId: String(row.interest_id),
      agentId: String(row.agent_id),
      sourceId: String(row.source_id),
      mailboxId: String(row.mailbox_id),
      matchRules: parseJson<Record<string, unknown>>(row.match_rules_json as string),
      activationTarget: row.activation_target ? String(row.activation_target) : null,
      createdAt: String(row.created_at),
    };
  }

  private mapInboxItem(row: Record<string, unknown>): InboxItem {
    return {
      itemId: String(row.item_id),
      sourceId: String(row.source_id),
      sourceNativeId: String(row.source_native_id),
      eventVariant: String(row.event_variant),
      mailboxId: String(row.mailbox_id),
      occurredAt: String(row.occurred_at),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json as string),
      rawPayload: parseJson<Record<string, unknown>>(row.raw_payload_json as string),
      deliveryHandle: row.delivery_handle_json
        ? parseJson(row.delivery_handle_json as string)
        : null,
      ackedAt: row.acked_at ? String(row.acked_at) : null,
    };
  }

  private mapActivation(row: Record<string, unknown>): Activation {
    return {
      activationId: String(row.activation_id),
      agentId: String(row.agent_id),
      mailboxId: String(row.mailbox_id),
      newItemCount: Number(row.new_item_count),
      summary: String(row.summary),
      createdAt: String(row.created_at),
      deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    };
  }

  private mapDelivery(row: Record<string, unknown>): DeliveryAttempt {
    return {
      deliveryId: String(row.delivery_id),
      provider: String(row.provider),
      surface: String(row.surface),
      targetRef: String(row.target_ref),
      threadRef: row.thread_ref ? String(row.thread_ref) : null,
      replyMode: row.reply_mode ? String(row.reply_mode) : null,
      kind: String(row.kind),
      payload: parseJson<Record<string, unknown>>(row.payload_json as string),
      status: row.status as DeliveryAttempt["status"],
      createdAt: String(row.created_at),
    };
  }
}
