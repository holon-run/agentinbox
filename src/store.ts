import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import type {
  ConsumerRecord,
  StreamEventRecord,
  StreamRecord,
  StreamStats,
} from "./backend";
import {
  Activation,
  ActivationItem,
  AppendSourceEventInput,
  AppendSourceEventResult,
  DeliveryAttempt,
  Inbox,
  InboxItem,
  Subscription,
  SubscriptionSource,
  SubscriptionStartPolicy,
} from "./model";
import { generateId, nowIso } from "./util";

const SCHEMA_VERSION = 4;

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

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const userVersion = this.userVersion();
    if (userVersion >= SCHEMA_VERSION) {
      this.createCurrentSchema();
      return;
    }

    if (userVersion < 1) {
      if (this.hasLegacySchema()) {
        this.migrateLegacySchema();
      } else {
        this.createCurrentSchema();
      }
      this.setUserVersion(1);
    }

    if (userVersion < 2 && this.needsActivationSchemaUpgrade()) {
      this.upgradeActivationSchema();
    }

    if (userVersion < 3 && this.needsSubscriptionActivationModeUpgrade()) {
      this.upgradeSubscriptionActivationModeSchema();
    }

    if (userVersion < 4 && this.needsActivationItemsUpgrade()) {
      this.upgradeActivationItemsSchema();
    }

    this.setUserVersion(SCHEMA_VERSION);
  }

  private hasLegacySchema(): boolean {
    return this.tableExists("interests")
      || this.columnExists("inbox_items", "mailbox_id")
      || this.columnExists("activations", "mailbox_id");
  }

  private migrateLegacySchema(): void {
    this.inTransaction(() => {
      this.createCurrentSchemaBase();

      this.db.exec(`
        create table if not exists inbox_items_v2 (
          item_id text primary key,
          source_id text not null,
          source_native_id text not null,
          event_variant text not null,
          inbox_id text not null,
          occurred_at text not null,
          metadata_json text not null,
          raw_payload_json text not null,
          delivery_handle_json text,
          acked_at text,
          unique(source_id, source_native_id, event_variant, inbox_id)
        );

        create table if not exists activations_v2 (
          activation_id text primary key,
          kind text not null,
          agent_id text not null,
          inbox_id text not null,
          subscription_ids_json text not null,
          source_ids_json text not null,
          new_item_count integer not null,
          summary text not null,
          items_json text,
          created_at text not null,
          delivered_at text
        );
      `);

      this.db.exec(`
        insert or ignore into inboxes (inbox_id, owner_agent_id, created_at)
        select mailbox_id, min(agent_id), min(created_at)
        from interests
        group by mailbox_id;

        insert or ignore into subscriptions (
          subscription_id, agent_id, source_id, inbox_id, match_rules_json,
          activation_target, activation_mode, start_policy, start_offset, start_time, created_at
        )
        select
          interest_id, agent_id, source_id, mailbox_id, match_rules_json,
          activation_target, 'activation_only', 'latest', null, null, created_at
        from interests;

        insert or ignore into inbox_items_v2 (
          item_id, source_id, source_native_id, event_variant, inbox_id, occurred_at,
          metadata_json, raw_payload_json, delivery_handle_json, acked_at
        )
        select
          item_id, source_id, source_native_id, event_variant, mailbox_id, occurred_at,
          metadata_json, raw_payload_json, delivery_handle_json, acked_at
        from inbox_items;

        insert or ignore into activations_v2 (
          activation_id, kind, agent_id, inbox_id, subscription_ids_json, source_ids_json, new_item_count, summary, items_json, created_at, delivered_at
        )
        select
          activation_id, 'agentinbox.activation', agent_id, mailbox_id, '[]', '[]', new_item_count, summary, null, created_at, delivered_at
        from activations;

        insert or ignore into streams (stream_id, source_id, stream_key, backend, created_at)
        select
          'stream_' || source_id,
          source_id,
          source_type || ':' || source_key,
          'sqlite',
          created_at
        from sources;

        insert or ignore into consumers (
          consumer_id, stream_id, subscription_id, consumer_key, start_policy,
          start_offset, start_time, next_offset, created_at, updated_at
        )
        select
          'consumer_' || subscription_id,
          'stream_' || source_id,
          subscription_id,
          'subscription:' || subscription_id,
          'latest',
          null,
          null,
          1,
          created_at,
          created_at
        from subscriptions;
      `);

      if (this.tableExists("interests")) {
        this.db.exec("drop table interests;");
      }
      if (this.tableExists("inbox_items")) {
        this.db.exec("drop table inbox_items;");
      }
      if (this.tableExists("activations")) {
        this.db.exec("drop table activations;");
      }

      this.db.exec(`
        alter table inbox_items_v2 rename to inbox_items;
        alter table activations_v2 rename to activations;
      `);

      this.createCurrentIndexes();
    });
  }

  private needsActivationSchemaUpgrade(): boolean {
    return !this.columnExists("activations", "kind")
      || !this.columnExists("activations", "subscription_ids_json")
      || !this.columnExists("activations", "source_ids_json");
  }

  private needsSubscriptionActivationModeUpgrade(): boolean {
    return !this.columnExists("subscriptions", "activation_mode");
  }

  private needsActivationItemsUpgrade(): boolean {
    return !this.columnExists("activations", "items_json");
  }

  private upgradeActivationSchema(): void {
    this.inTransaction(() => {
      this.db.exec(`
        create table if not exists activations_v3 (
          activation_id text primary key,
          kind text not null,
          agent_id text not null,
          inbox_id text not null,
          subscription_ids_json text not null,
          source_ids_json text not null,
          new_item_count integer not null,
          summary text not null,
          items_json text,
          created_at text not null,
          delivered_at text
        );
      `);

      this.db.exec(`
        insert or ignore into activations_v3 (
          activation_id, kind, agent_id, inbox_id, subscription_ids_json, source_ids_json, new_item_count, summary, items_json, created_at, delivered_at
        )
        select
          activation_id,
          'agentinbox.activation',
          agent_id,
          inbox_id,
          '[]',
          '[]',
          new_item_count,
          summary,
          null,
          created_at,
          delivered_at
        from activations;
      `);

      this.db.exec("drop table activations;");
      this.db.exec("alter table activations_v3 rename to activations;");
    });
  }

  private upgradeSubscriptionActivationModeSchema(): void {
    this.inTransaction(() => {
      this.db.exec("alter table subscriptions add column activation_mode text not null default 'activation_only';");
    });
  }

  private upgradeActivationItemsSchema(): void {
    this.inTransaction(() => {
      this.db.exec("alter table activations add column items_json text;");
    });
  }

  private createCurrentSchema(): void {
    this.createCurrentSchemaBase();
    this.createCurrentIndexes();
  }

  private createCurrentSchemaBase(): void {
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

      create table if not exists inboxes (
        inbox_id text primary key,
        owner_agent_id text not null,
        created_at text not null
      );

      create table if not exists subscriptions (
        subscription_id text primary key,
        agent_id text not null,
        source_id text not null,
        inbox_id text not null,
        match_rules_json text not null,
        activation_target text,
        activation_mode text not null,
        start_policy text not null,
        start_offset integer,
        start_time text,
        created_at text not null
      );

      create table if not exists inbox_items (
        item_id text primary key,
        source_id text not null,
        source_native_id text not null,
        event_variant text not null,
        inbox_id text not null,
        occurred_at text not null,
        metadata_json text not null,
        raw_payload_json text not null,
        delivery_handle_json text,
        acked_at text,
        unique(source_id, source_native_id, event_variant, inbox_id)
      );

      create table if not exists activations (
        activation_id text primary key,
        kind text not null,
        agent_id text not null,
        inbox_id text not null,
        subscription_ids_json text not null,
        source_ids_json text not null,
        new_item_count integer not null,
        summary text not null,
        items_json text,
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

      create table if not exists streams (
        stream_id text primary key,
        source_id text not null unique,
        stream_key text not null unique,
        backend text not null,
        created_at text not null
      );

      create table if not exists stream_events (
        offset integer primary key autoincrement,
        stream_event_id text not null unique,
        stream_id text not null,
        source_id text not null,
        source_native_id text not null,
        event_variant text not null,
        occurred_at text not null,
        metadata_json text not null,
        raw_payload_json text not null,
        delivery_handle_json text,
        created_at text not null,
        unique(stream_id, source_native_id, event_variant)
      );

      create table if not exists consumers (
        consumer_id text primary key,
        stream_id text not null,
        subscription_id text not null unique,
        consumer_key text not null unique,
        start_policy text not null,
        start_offset integer,
        start_time text,
        next_offset integer not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists consumer_commits (
        commit_id text primary key,
        consumer_id text not null,
        stream_id text not null,
        committed_offset integer not null,
        committed_at text not null
      );
    `);
  }

  private createCurrentIndexes(): void {
    this.db.exec(`
      create index if not exists idx_stream_events_stream_offset
        on stream_events(stream_id, offset);

      create index if not exists idx_stream_events_stream_occurred_at
        on stream_events(stream_id, occurred_at);

      create index if not exists idx_consumers_stream
        on consumers(stream_id);

      create index if not exists idx_consumer_commits_consumer
        on consumer_commits(consumer_id, committed_offset);
    `);
  }

  private persist(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  private inTransaction(fn: () => void): void {
    this.db.exec("begin");
    try {
      fn();
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private userVersion(): number {
    const row = this.getOne("pragma user_version;");
    if (!row) {
      return 0;
    }
    return Number(row.user_version ?? 0);
  }

  private setUserVersion(version: number): void {
    this.db.exec(`pragma user_version = ${version};`);
  }

  private tableExists(name: string): boolean {
    const row = this.getOne(
      "select name from sqlite_master where type = 'table' and name = ?",
      [name],
    );
    return Boolean(row);
  }

  private columnExists(tableName: string, columnName: string): boolean {
    if (!this.tableExists(tableName)) {
      return false;
    }
    const rows = this.getAll(`pragma table_info(${tableName});`);
    return rows.some((row) => String(row.name) === columnName);
  }

  getSourceByKey(sourceType: string, sourceKey: string): SubscriptionSource | null {
    const row = this.getOne(
      "select * from sources where source_type = ? and source_key = ?",
      [sourceType, sourceKey],
    );
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

  updateSourceRuntime(
    sourceId: string,
    input: { status?: SubscriptionSource["status"]; checkpoint?: string | null },
  ): void {
    const current = this.getSource(sourceId);
    if (!current) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    this.db.run(
      `
      update sources
      set status = ?, checkpoint = ?, updated_at = ?
      where source_id = ?
    `,
      [
        input.status ?? current.status,
        input.checkpoint ?? current.checkpoint ?? null,
        nowIso(),
        sourceId,
      ],
    );
    this.persist();
  }

  getInbox(inboxId: string): Inbox | null {
    const row = this.getOne("select * from inboxes where inbox_id = ?", [inboxId]);
    return row ? this.mapInbox(row) : null;
  }

  insertInbox(inbox: Inbox): void {
    this.db.run(
      `
      insert into inboxes (inbox_id, owner_agent_id, created_at)
      values (?, ?, ?)
    `,
      [inbox.inboxId, inbox.ownerAgentId, inbox.createdAt],
    );
    this.persist();
  }

  listInboxes(): Inbox[] {
    const rows = this.getAll("select * from inboxes order by created_at asc");
    return rows.map((row) => this.mapInbox(row));
  }

  getSubscription(subscriptionId: string): Subscription | null {
    const row = this.getOne("select * from subscriptions where subscription_id = ?", [subscriptionId]);
    return row ? this.mapSubscription(row) : null;
  }

  insertSubscription(subscription: Subscription): void {
    this.db.run(
      `
      insert into subscriptions (
        subscription_id, agent_id, source_id, inbox_id, match_rules_json,
        activation_target, activation_mode, start_policy, start_offset, start_time, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        subscription.subscriptionId,
        subscription.agentId,
        subscription.sourceId,
        subscription.inboxId,
        JSON.stringify(subscription.matchRules),
        subscription.activationTarget ?? null,
        subscription.activationMode,
        subscription.startPolicy,
        subscription.startOffset ?? null,
        subscription.startTime ?? null,
        subscription.createdAt,
      ],
    );
    this.persist();
  }

  listSubscriptions(): Subscription[] {
    const rows = this.getAll("select * from subscriptions order by created_at asc");
    return rows.map((row) => this.mapSubscription(row));
  }

  listSubscriptionsForSource(sourceId: string): Subscription[] {
    const rows = this.getAll(
      "select * from subscriptions where source_id = ? order by created_at asc",
      [sourceId],
    );
    return rows.map((row) => this.mapSubscription(row));
  }

  insertInboxItem(item: InboxItem): boolean {
    const before = this.changes();
    this.db.run(
      `
      insert or ignore into inbox_items (
        item_id, source_id, source_native_id, event_variant, inbox_id, occurred_at,
        metadata_json, raw_payload_json, delivery_handle_json, acked_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        item.itemId,
        item.sourceId,
        item.sourceNativeId,
        item.eventVariant,
        item.inboxId,
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

  listInboxItems(inboxId: string): InboxItem[] {
    const rows = this.getAll(
      "select * from inbox_items where inbox_id = ? order by occurred_at asc, item_id asc",
      [inboxId],
    );
    return rows.map((row) => this.mapInboxItem(row));
  }

  ackItems(inboxId: string, itemIds: string[], ackedAt: string): number {
    let changes = 0;
    for (const itemId of itemIds) {
      const before = this.changes();
      this.db.run(
        `
        update inbox_items
        set acked_at = ?
        where inbox_id = ? and item_id = ? and acked_at is null
      `,
        [ackedAt, inboxId, itemId],
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
        activation_id, kind, agent_id, inbox_id, subscription_ids_json, source_ids_json, new_item_count, summary, items_json, created_at, delivered_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        activation.activationId,
        activation.kind,
        activation.agentId,
        activation.inboxId,
        JSON.stringify(activation.subscriptionIds),
        JSON.stringify(activation.sourceIds),
        activation.newItemCount,
        activation.summary,
        activation.items ? JSON.stringify(activation.items) : null,
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

  insertStream(stream: StreamRecord): void {
    this.db.run(
      `
      insert into streams (stream_id, source_id, stream_key, backend, created_at)
      values (?, ?, ?, ?, ?)
    `,
      [stream.streamId, stream.sourceId, stream.streamKey, stream.backend, stream.createdAt],
    );
    this.persist();
  }

  getStream(streamId: string): StreamRecord | null {
    const row = this.getOne("select * from streams where stream_id = ?", [streamId]);
    return row ? this.mapStream(row) : null;
  }

  listStreams(): StreamRecord[] {
    const rows = this.getAll("select * from streams order by created_at asc");
    return rows.map((row) => this.mapStream(row));
  }

  getStreamBySourceId(sourceId: string): StreamRecord | null {
    const row = this.getOne("select * from streams where source_id = ?", [sourceId]);
    return row ? this.mapStream(row) : null;
  }

  insertStreamEvent(
    streamId: string,
    event: AppendSourceEventInput,
  ): AppendSourceEventResult {
    const before = this.changes();
    this.db.run(
      `
      insert or ignore into stream_events (
        stream_event_id, stream_id, source_id, source_native_id, event_variant,
        occurred_at, metadata_json, raw_payload_json, delivery_handle_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        generateId("strevt"),
        streamId,
        event.sourceId,
        event.sourceNativeId,
        event.eventVariant,
        event.occurredAt ?? nowIso(),
        JSON.stringify(event.metadata ?? {}),
        JSON.stringify(event.rawPayload ?? {}),
        event.deliveryHandle ? JSON.stringify(event.deliveryHandle) : null,
        nowIso(),
      ],
    );
    const inserted = this.changes() > before;
    if (inserted) {
      this.persist();
      return {
        appended: 1,
        deduped: 0,
        lastOffset: this.lastInsertRowId(),
      };
    }
    return { appended: 0, deduped: 1, lastOffset: null };
  }

  readStreamEvents(streamId: string, nextOffset: number, limit: number): StreamEventRecord[] {
    const rows = this.getAll(
      `
      select * from stream_events
      where stream_id = ? and offset >= ?
      order by offset asc
      limit ?
    `,
      [streamId, nextOffset, limit],
    );
    return rows.map((row) => this.mapStreamEvent(row));
  }

  getStreamStats(streamId: string): StreamStats {
    const row = this.getOne(
      `
      select count(*) as event_count, max(offset) as high_watermark_offset
      from stream_events
      where stream_id = ?
    `,
      [streamId],
    );
    return {
      streamId,
      eventCount: Number(row?.event_count ?? 0),
      highWatermarkOffset: row?.high_watermark_offset != null
        ? Number(row.high_watermark_offset)
        : null,
    };
  }

  findOffsetAtOrAfter(streamId: string, occurredAt: string): number | null {
    const row = this.getOne(
      `
      select offset
      from stream_events
      where stream_id = ? and occurred_at >= ?
      order by occurred_at asc, offset asc
      limit 1
    `,
      [streamId, occurredAt],
    );
    return row?.offset != null ? Number(row.offset) : null;
  }

  countPendingEvents(streamId: string, nextOffset: number): number {
    const row = this.getOne(
      "select count(*) as count from stream_events where stream_id = ? and offset >= ?",
      [streamId, nextOffset],
    );
    return Number(row?.count ?? 0);
  }

  insertConsumer(consumer: ConsumerRecord): void {
    this.db.run(
      `
      insert into consumers (
        consumer_id, stream_id, subscription_id, consumer_key, start_policy,
        start_offset, start_time, next_offset, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        consumer.consumerId,
        consumer.streamId,
        consumer.subscriptionId,
        consumer.consumerKey,
        consumer.startPolicy,
        consumer.startOffset ?? null,
        consumer.startTime ?? null,
        consumer.nextOffset,
        consumer.createdAt,
        consumer.updatedAt,
      ],
    );
    this.persist();
  }

  getConsumer(consumerId: string): ConsumerRecord | null {
    const row = this.getOne("select * from consumers where consumer_id = ?", [consumerId]);
    return row ? this.mapConsumer(row) : null;
  }

  getConsumerBySubscriptionId(subscriptionId: string): ConsumerRecord | null {
    const row = this.getOne("select * from consumers where subscription_id = ?", [subscriptionId]);
    return row ? this.mapConsumer(row) : null;
  }

  listConsumers(): ConsumerRecord[] {
    const rows = this.getAll("select * from consumers order by created_at asc");
    return rows.map((row) => this.mapConsumer(row));
  }

  updateConsumerOffset(
    consumerId: string,
    nextOffset: number,
    committedOffset: number,
  ): ConsumerRecord {
    const consumer = this.getConsumer(consumerId);
    if (!consumer) {
      throw new Error(`unknown consumer: ${consumerId}`);
    }
    const updatedAt = nowIso();
    this.inTransaction(() => {
      this.db.run(
        `
        update consumers
        set next_offset = ?, updated_at = ?
        where consumer_id = ?
      `,
        [nextOffset, updatedAt, consumerId],
      );
      this.db.run(
        `
        insert into consumer_commits (
          commit_id, consumer_id, stream_id, committed_offset, committed_at
        ) values (?, ?, ?, ?, ?)
      `,
        [generateId("commit"), consumerId, consumer.streamId, committedOffset, updatedAt],
      );
    });
    this.persist();
    return this.getConsumer(consumerId)!;
  }

  resetConsumer(
    consumerId: string,
    input: {
      startPolicy: SubscriptionStartPolicy;
      startOffset: number | null;
      startTime: string | null;
      nextOffset: number;
    },
  ): ConsumerRecord {
    this.db.run(
      `
      update consumers
      set start_policy = ?, start_offset = ?, start_time = ?, next_offset = ?, updated_at = ?
      where consumer_id = ?
    `,
      [
        input.startPolicy,
        input.startOffset ?? null,
        input.startTime ?? null,
        input.nextOffset,
        nowIso(),
        consumerId,
      ],
    );
    this.persist();
    return this.getConsumer(consumerId)!;
  }

  getCounts(): Record<string, number> {
    return {
      sources: this.count("sources"),
      subscriptions: this.count("subscriptions"),
      inboxes: this.count("inboxes"),
      streamEvents: this.count("stream_events"),
      consumers: this.count("consumers"),
      inboxItems: this.count("inbox_items"),
      pendingInboxItems: this.count("inbox_items where acked_at is null"),
      activations: this.count("activations"),
      deliveries: this.count("deliveries"),
    };
  }

  private count(tableOrClause: string): number {
    const row = this.getOne(`select count(*) as count from ${tableOrClause}`);
    return row ? Number(row.count) : 0;
  }

  private changes(): number {
    const row = this.getOne("select changes() as count");
    return row ? Number(row.count) : 0;
  }

  private lastInsertRowId(): number {
    const row = this.getOne("select last_insert_rowid() as rowid");
    return Number(row?.rowid ?? 0);
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

  private mapInbox(row: Record<string, unknown>): Inbox {
    return {
      inboxId: String(row.inbox_id),
      ownerAgentId: String(row.owner_agent_id),
      createdAt: String(row.created_at),
    };
  }

  private mapSubscription(row: Record<string, unknown>): Subscription {
    return {
      subscriptionId: String(row.subscription_id),
      agentId: String(row.agent_id),
      sourceId: String(row.source_id),
      inboxId: String(row.inbox_id),
      matchRules: parseJson<Record<string, unknown>>(row.match_rules_json as string),
      activationTarget: row.activation_target ? String(row.activation_target) : null,
      activationMode: (row.activation_mode ? String(row.activation_mode) : "activation_only") as Subscription["activationMode"],
      startPolicy: row.start_policy as SubscriptionStartPolicy,
      startOffset: row.start_offset != null ? Number(row.start_offset) : null,
      startTime: row.start_time ? String(row.start_time) : null,
      createdAt: String(row.created_at),
    };
  }

  private mapInboxItem(row: Record<string, unknown>): InboxItem {
    return {
      itemId: String(row.item_id),
      sourceId: String(row.source_id),
      sourceNativeId: String(row.source_native_id),
      eventVariant: String(row.event_variant),
      inboxId: String(row.inbox_id),
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
      kind: "agentinbox.activation",
      activationId: String(row.activation_id),
      agentId: String(row.agent_id),
      inboxId: String(row.inbox_id),
      subscriptionIds: parseJson<string[]>(row.subscription_ids_json as string),
      sourceIds: parseJson<string[]>(row.source_ids_json as string),
      newItemCount: Number(row.new_item_count),
      summary: String(row.summary),
      items: row.items_json ? parseJson<ActivationItem[]>(row.items_json as string) : undefined,
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

  private mapStream(row: Record<string, unknown>): StreamRecord {
    return {
      streamId: String(row.stream_id),
      sourceId: String(row.source_id),
      streamKey: String(row.stream_key),
      backend: String(row.backend),
      createdAt: String(row.created_at),
    };
  }

  private mapStreamEvent(row: Record<string, unknown>): StreamEventRecord {
    return {
      offset: Number(row.offset),
      streamEventId: String(row.stream_event_id),
      streamId: String(row.stream_id),
      sourceId: String(row.source_id),
      sourceNativeId: String(row.source_native_id),
      eventVariant: String(row.event_variant),
      occurredAt: String(row.occurred_at),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json as string),
      rawPayload: parseJson<Record<string, unknown>>(row.raw_payload_json as string),
      deliveryHandle: row.delivery_handle_json
        ? parseJson<Record<string, unknown>>(row.delivery_handle_json as string)
        : null,
      createdAt: String(row.created_at),
    };
  }

  private mapConsumer(row: Record<string, unknown>): ConsumerRecord {
    return {
      consumerId: String(row.consumer_id),
      streamId: String(row.stream_id),
      subscriptionId: String(row.subscription_id),
      consumerKey: String(row.consumer_key),
      nextOffset: Number(row.next_offset),
      startPolicy: row.start_policy as SubscriptionStartPolicy,
      startOffset: row.start_offset != null ? Number(row.start_offset) : null,
      startTime: row.start_time ? String(row.start_time) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
