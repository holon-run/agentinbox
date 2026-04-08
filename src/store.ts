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
  ActivationDispatchState,
  ActivationTarget,
  AddWebhookActivationTargetInput,
  Agent,
  AppendSourceEventInput,
  AppendSourceEventResult,
  DeliveryAttempt,
  Inbox,
  InboxItem,
  ListInboxItemsOptions,
  RegisterAgentInput,
  Subscription,
  SubscriptionSource,
  SubscriptionStartPolicy,
  TerminalActivationTarget,
  WebhookActivationTarget,
} from "./model";
import { generateId, nowIso } from "./util";

const SCHEMA_VERSION = 9;
type SqlBindParams = unknown[];

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
    if (userVersion === 0) {
      this.dropKnownTables();
      this.createCurrentSchema();
      this.setUserVersion(SCHEMA_VERSION);
      return;
    }
    if (userVersion !== SCHEMA_VERSION) {
      throw new Error(
        `unsupported database schema version ${userVersion}; delete ${this.dbPath} to recreate`,
      );
    }
    this.createCurrentSchema();
  }

  private dropKnownTables(): void {
    const tables = [
      "consumer_commits",
      "consumers",
      "stream_events",
      "streams",
      "deliveries",
      "activations",
      "inbox_items",
      "activation_dispatch_states",
      "activation_targets",
      "subscriptions",
      "inboxes",
      "agents",
      "sources",
      "terminal_dispatch_states",
      "terminal_targets",
      "interests",
    ];
    this.inTransaction(() => {
      for (const table of tables) {
        if (this.tableExists(table)) {
          this.db.exec(`drop table ${table};`);
        }
      }
    });
  }

  private createCurrentSchema(): void {
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

      create table if not exists agents (
        agent_id text primary key,
        runtime_kind text not null,
        runtime_session_id text,
        created_at text not null,
        updated_at text not null,
        last_seen_at text not null
      );

      create table if not exists inboxes (
        inbox_id text primary key,
        owner_agent_id text not null unique,
        created_at text not null
      );

      create table if not exists subscriptions (
        subscription_id text primary key,
        agent_id text not null,
        source_id text not null,
        match_rules_json text not null,
        start_policy text not null,
        start_offset integer,
        start_time text,
        created_at text not null
      );

      create table if not exists activation_targets (
        target_id text primary key,
        agent_id text not null,
        kind text not null,
        mode text not null,
        notify_lease_ms integer not null,
        url text,
        runtime_kind text,
        runtime_session_id text,
        backend text,
        tmux_pane_id text,
        tty text,
        term_program text,
        iterm_session_id text,
        created_at text not null,
        updated_at text not null,
        last_seen_at text not null
      );

      create table if not exists activation_dispatch_states (
        agent_id text not null,
        target_id text not null,
        status text not null,
        lease_expires_at text,
        pending_new_item_count integer not null,
        pending_summary text,
        pending_subscription_ids_json text not null,
        pending_source_ids_json text not null,
        updated_at text not null,
        primary key (agent_id, target_id)
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
        target_id text not null,
        target_kind text not null,
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

      create unique index if not exists idx_activation_targets_terminal_tmux
        on activation_targets(tmux_pane_id)
        where kind = 'terminal' and tmux_pane_id is not null;

      create unique index if not exists idx_activation_targets_terminal_iterm
        on activation_targets(iterm_session_id)
        where kind = 'terminal' and iterm_session_id is not null;

      create unique index if not exists idx_activation_targets_runtime_session
        on activation_targets(runtime_kind, runtime_session_id)
        where kind = 'terminal' and runtime_session_id is not null;

      create index if not exists idx_activation_dispatch_states_target
        on activation_dispatch_states(target_id, lease_expires_at);

      create index if not exists idx_inbox_items_acked_at
        on inbox_items(acked_at);

      create index if not exists idx_inbox_items_inbox_acked_at
        on inbox_items(inbox_id, acked_at);

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

  getAgent(agentId: string): Agent | null {
    const row = this.getOne("select * from agents where agent_id = ?", [agentId]);
    return row ? this.mapAgent(row) : null;
  }

  insertAgent(agent: Agent): void {
    this.db.run(
      `
      insert into agents (
        agent_id, runtime_kind, runtime_session_id, created_at, updated_at, last_seen_at
      ) values (?, ?, ?, ?, ?, ?)
    `,
      [
        agent.agentId,
        agent.runtimeKind,
        agent.runtimeSessionId ?? null,
        agent.createdAt,
        agent.updatedAt,
        agent.lastSeenAt,
      ],
    );
    this.persist();
  }

  updateAgent(agentId: string, input: {
    runtimeKind: Agent["runtimeKind"];
    runtimeSessionId?: string | null;
    updatedAt: string;
    lastSeenAt: string;
  }): Agent {
    this.db.run(
      `
      update agents
      set runtime_kind = ?, runtime_session_id = ?, updated_at = ?, last_seen_at = ?
      where agent_id = ?
    `,
      [
        input.runtimeKind,
        input.runtimeSessionId ?? null,
        input.updatedAt,
        input.lastSeenAt,
        agentId,
      ],
    );
    this.persist();
    return this.getAgent(agentId)!;
  }

  listAgents(): Agent[] {
    const rows = this.getAll("select * from agents order by created_at asc");
    return rows.map((row) => this.mapAgent(row));
  }

  getInbox(inboxId: string): Inbox | null {
    const row = this.getOne("select * from inboxes where inbox_id = ?", [inboxId]);
    return row ? this.mapInbox(row) : null;
  }

  getInboxByAgentId(agentId: string): Inbox | null {
    const row = this.getOne("select * from inboxes where owner_agent_id = ?", [agentId]);
    return row ? this.mapInbox(row) : null;
  }

  insertInbox(inbox: Inbox): void {
    this.db.run(
      "insert into inboxes (inbox_id, owner_agent_id, created_at) values (?, ?, ?)",
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
        subscription_id, agent_id, source_id, match_rules_json, start_policy, start_offset, start_time, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        subscription.subscriptionId,
        subscription.agentId,
        subscription.sourceId,
        JSON.stringify(subscription.matchRules),
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

  listSubscriptionsForAgent(agentId: string): Subscription[] {
    const rows = this.getAll(
      "select * from subscriptions where agent_id = ? order by created_at asc",
      [agentId],
    );
    return rows.map((row) => this.mapSubscription(row));
  }

  getActivationTarget(targetId: string): ActivationTarget | null {
    const row = this.getOne("select * from activation_targets where target_id = ?", [targetId]);
    return row ? this.mapActivationTarget(row) : null;
  }

  getTerminalActivationTargetByTmuxPaneId(tmuxPaneId: string): TerminalActivationTarget | null {
    const row = this.getOne(
      "select * from activation_targets where kind = 'terminal' and tmux_pane_id = ?",
      [tmuxPaneId],
    );
    const target = row ? this.mapActivationTarget(row) : null;
    return target?.kind === "terminal" ? target : null;
  }

  getTerminalActivationTargetByItermSessionId(itermSessionId: string): TerminalActivationTarget | null {
    const row = this.getOne(
      "select * from activation_targets where kind = 'terminal' and iterm_session_id = ?",
      [itermSessionId],
    );
    const target = row ? this.mapActivationTarget(row) : null;
    return target?.kind === "terminal" ? target : null;
  }

  getTerminalActivationTargetByTty(tty: string): TerminalActivationTarget | null {
    const row = this.getOne(
      "select * from activation_targets where kind = 'terminal' and tty = ?",
      [tty],
    );
    const target = row ? this.mapActivationTarget(row) : null;
    return target?.kind === "terminal" ? target : null;
  }

  getTerminalActivationTargetByRuntimeSession(runtimeKind: string, runtimeSessionId: string): TerminalActivationTarget | null {
    const row = this.getOne(
      "select * from activation_targets where kind = 'terminal' and runtime_kind = ? and runtime_session_id = ?",
      [runtimeKind, runtimeSessionId],
    );
    const target = row ? this.mapActivationTarget(row) : null;
    return target?.kind === "terminal" ? target : null;
  }

  insertActivationTarget(target: ActivationTarget): void {
    if (target.kind === "webhook") {
      this.db.run(
        `
        insert into activation_targets (
          target_id, agent_id, kind, mode, notify_lease_ms, url, created_at, updated_at, last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          target.targetId,
          target.agentId,
          target.kind,
          target.mode,
          target.notifyLeaseMs,
          target.url,
          target.createdAt,
          target.updatedAt,
          target.lastSeenAt,
        ],
      );
    } else {
      this.db.run(
        `
        insert into activation_targets (
          target_id, agent_id, kind, mode, notify_lease_ms,
          runtime_kind, runtime_session_id, backend, tmux_pane_id, tty, term_program, iterm_session_id,
          created_at, updated_at, last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          target.targetId,
          target.agentId,
          target.kind,
          target.mode,
          target.notifyLeaseMs,
          target.runtimeKind,
          target.runtimeSessionId ?? null,
          target.backend,
          target.tmuxPaneId ?? null,
          target.tty ?? null,
          target.termProgram ?? null,
          target.itermSessionId ?? null,
          target.createdAt,
          target.updatedAt,
          target.lastSeenAt,
        ],
      );
    }
    this.persist();
  }

  updateTerminalActivationTargetHeartbeat(
    targetId: string,
    input: {
      runtimeKind: TerminalActivationTarget["runtimeKind"];
      runtimeSessionId?: string | null;
      tmuxPaneId?: string | null;
      tty?: string | null;
      termProgram?: string | null;
      itermSessionId?: string | null;
      updatedAt: string;
      lastSeenAt: string;
    },
  ): TerminalActivationTarget {
    this.db.run(
      `
      update activation_targets
      set runtime_kind = ?, runtime_session_id = ?, tmux_pane_id = ?, tty = ?, term_program = ?, iterm_session_id = ?, updated_at = ?, last_seen_at = ?
      where target_id = ? and kind = 'terminal'
    `,
      [
        input.runtimeKind,
        input.runtimeSessionId ?? null,
        input.tmuxPaneId ?? null,
        input.tty ?? null,
        input.termProgram ?? null,
        input.itermSessionId ?? null,
        input.updatedAt,
        input.lastSeenAt,
        targetId,
      ],
    );
    this.persist();
    const target = this.getActivationTarget(targetId);
    if (!target || target.kind !== "terminal") {
      throw new Error(`unknown terminal activation target: ${targetId}`);
    }
    return target;
  }

  listActivationTargets(): ActivationTarget[] {
    const rows = this.getAll("select * from activation_targets order by created_at asc");
    return rows.map((row) => this.mapActivationTarget(row));
  }

  listActivationTargetsForAgent(agentId: string): ActivationTarget[] {
    const rows = this.getAll(
      "select * from activation_targets where agent_id = ? order by created_at asc",
      [agentId],
    );
    return rows.map((row) => this.mapActivationTarget(row));
  }

  deleteActivationTarget(agentId: string, targetId: string): void {
    this.inTransaction(() => {
      this.db.run("delete from activation_dispatch_states where agent_id = ? and target_id = ?", [agentId, targetId]);
      this.db.run("delete from activation_targets where agent_id = ? and target_id = ?", [agentId, targetId]);
    });
    this.persist();
  }

  getActivationDispatchState(agentId: string, targetId: string): ActivationDispatchState | null {
    const row = this.getOne(
      "select * from activation_dispatch_states where agent_id = ? and target_id = ?",
      [agentId, targetId],
    );
    return row ? this.mapActivationDispatchState(row) : null;
  }

  listActivationDispatchStates(): ActivationDispatchState[] {
    const rows = this.getAll("select * from activation_dispatch_states order by updated_at asc");
    return rows.map((row) => this.mapActivationDispatchState(row));
  }

  listActivationDispatchStatesForAgent(agentId: string): ActivationDispatchState[] {
    const rows = this.getAll(
      "select * from activation_dispatch_states where agent_id = ? order by updated_at asc",
      [agentId],
    );
    return rows.map((row) => this.mapActivationDispatchState(row));
  }

  upsertActivationDispatchState(state: ActivationDispatchState): void {
    this.db.run(
      `
      insert into activation_dispatch_states (
        agent_id, target_id, status, lease_expires_at, pending_new_item_count, pending_summary,
        pending_subscription_ids_json, pending_source_ids_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(agent_id, target_id) do update set
        status = excluded.status,
        lease_expires_at = excluded.lease_expires_at,
        pending_new_item_count = excluded.pending_new_item_count,
        pending_summary = excluded.pending_summary,
        pending_subscription_ids_json = excluded.pending_subscription_ids_json,
        pending_source_ids_json = excluded.pending_source_ids_json,
        updated_at = excluded.updated_at
    `,
      [
        state.agentId,
        state.targetId,
        state.status,
        state.leaseExpiresAt ?? null,
        state.pendingNewItemCount,
        state.pendingSummary ?? null,
        JSON.stringify(state.pendingSubscriptionIds),
        JSON.stringify(state.pendingSourceIds),
        state.updatedAt,
      ],
    );
    this.persist();
  }

  deleteActivationDispatchState(agentId: string, targetId: string): void {
    this.db.run(
      "delete from activation_dispatch_states where agent_id = ? and target_id = ?",
      [agentId, targetId],
    );
    this.persist();
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

  listInboxItems(inboxId: string, options?: ListInboxItemsOptions): InboxItem[] {
    const includeAcked = options?.includeAcked ?? false;
    const filters = ["inbox_id = ?"];
    const params: Array<string | number | null> = [inboxId];

    if (!includeAcked) {
      filters.push("acked_at is null");
    }

    if (options?.afterItemId) {
      const anchor = this.getOne(
        "select occurred_at, item_id from inbox_items where inbox_id = ? and item_id = ?",
        [inboxId, options.afterItemId],
      );
      if (!anchor) {
        throw new Error(`unknown inbox item: ${options.afterItemId}`);
      }
      filters.push("((occurred_at > ?) or (occurred_at = ? and item_id > ?))");
      params.push(String(anchor.occurred_at), String(anchor.occurred_at), String(anchor.item_id));
    }

    const rows = this.getAll(
      `select * from inbox_items where ${filters.join(" and ")} order by occurred_at asc, item_id asc`,
      params,
    );
    return rows.map((row) => this.mapInboxItem(row));
  }

  ackItems(inboxId: string, itemIds: string[], ackedAt: string): number {
    let changes = 0;
    for (const itemId of itemIds) {
      this.db.run(
        `
        update inbox_items
        set acked_at = ?
        where inbox_id = ? and item_id = ? and acked_at is null
      `,
        [ackedAt, inboxId, itemId],
      );
      changes += this.changes();
    }
    if (changes > 0) {
      this.persist();
    }
    return changes;
  }

  ackItemsThrough(inboxId: string, itemId: string, ackedAt: string): number {
    const anchor = this.getOne(
      "select occurred_at, item_id from inbox_items where inbox_id = ? and item_id = ?",
      [inboxId, itemId],
    );
    if (!anchor) {
      throw new Error(`unknown inbox item: ${itemId}`);
    }
    this.db.run(
      `
      update inbox_items
      set acked_at = ?
      where inbox_id = ?
        and acked_at is null
        and ((occurred_at < ?) or (occurred_at = ? and item_id <= ?))
    `,
      [ackedAt, inboxId, String(anchor.occurred_at), String(anchor.occurred_at), String(anchor.item_id)],
    );
    const changes = this.changes();
    if (changes > 0) {
      this.persist();
    }
    return changes;
  }

  deleteAckedInboxItems(inboxId: string, olderThan: string): number {
    this.db.run(
      `
      delete from inbox_items
      where inbox_id = ?
        and acked_at is not null
        and acked_at < ?
    `,
      [inboxId, olderThan],
    );
    const changes = this.changes();
    if (changes > 0) {
      this.persist();
    }
    return changes;
  }

  deleteAckedInboxItemsGlobal(olderThan: string): number {
    this.db.run(
      `
      delete from inbox_items
      where acked_at is not null
        and acked_at < ?
    `,
      [olderThan],
    );
    const changes = this.changes();
    if (changes > 0) {
      this.persist();
    }
    return changes;
  }

  countInboxItems(inboxId: string, includeAcked: boolean): number {
    const row = this.getOne(
      `
      select count(*) as count
      from inbox_items
      where inbox_id = ?
      ${includeAcked ? "" : "and acked_at is null"}
    `,
      [inboxId],
    );
    return Number(row?.count ?? 0);
  }

  insertActivation(activation: Activation): void {
    this.db.run(
      `
      insert into activations (
        activation_id, kind, agent_id, inbox_id, target_id, target_kind,
        subscription_ids_json, source_ids_json, new_item_count, summary, items_json, created_at, delivered_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        activation.activationId,
        activation.kind,
        activation.agentId,
        activation.inboxId,
        activation.targetId,
        activation.targetKind,
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
      "insert into streams (stream_id, source_id, stream_key, backend, created_at) values (?, ?, ?, ?, ?)",
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

  insertStreamEvent(streamId: string, event: AppendSourceEventInput): AppendSourceEventResult {
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
      highWatermarkOffset: row?.high_watermark_offset != null ? Number(row.high_watermark_offset) : null,
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

  updateConsumerOffset(consumerId: string, nextOffset: number, committedOffset: number): ConsumerRecord {
    const consumer = this.getConsumer(consumerId);
    if (!consumer) {
      throw new Error(`unknown consumer: ${consumerId}`);
    }
    const updatedAt = nowIso();
    this.inTransaction(() => {
      this.db.run(
        "update consumers set next_offset = ?, updated_at = ? where consumer_id = ?",
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
      agents: this.count("agents"),
      subscriptions: this.count("subscriptions"),
      inboxes: this.count("inboxes"),
      activationTargets: this.count("activation_targets"),
      activationDispatchStates: this.count("activation_dispatch_states"),
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

  private getOne(sql: string, params: SqlBindParams = []): Record<string, unknown> | undefined {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params as never);
      if (!statement.step()) {
        return undefined;
      }
      return statement.getAsObject() as Record<string, unknown>;
    } finally {
      statement.free();
    }
  }

  private getAll(sql: string, params: SqlBindParams = []): Record<string, unknown>[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params as never);
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

  private mapAgent(row: Record<string, unknown>): Agent {
    return {
      agentId: String(row.agent_id),
      runtimeKind: row.runtime_kind as Agent["runtimeKind"],
      runtimeSessionId: row.runtime_session_id ? String(row.runtime_session_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastSeenAt: String(row.last_seen_at),
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
      matchRules: parseJson<Record<string, unknown>>(row.match_rules_json as string),
      startPolicy: row.start_policy as SubscriptionStartPolicy,
      startOffset: row.start_offset != null ? Number(row.start_offset) : null,
      startTime: row.start_time ? String(row.start_time) : null,
      createdAt: String(row.created_at),
    };
  }

  private mapActivationTarget(row: Record<string, unknown>): ActivationTarget {
    if (String(row.kind) === "webhook") {
      const url = typeof row.url === "string" && row.url.trim().length > 0 ? row.url.trim() : null;
      if (!url) {
        throw new Error(`invalid webhook activation target: ${String(row.target_id)}`);
      }
      return {
        targetId: String(row.target_id),
        agentId: String(row.agent_id),
        kind: "webhook",
        mode: row.mode as WebhookActivationTarget["mode"],
        url,
        notifyLeaseMs: Number(row.notify_lease_ms),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastSeenAt: String(row.last_seen_at),
      };
    }
    return {
      targetId: String(row.target_id),
      agentId: String(row.agent_id),
      kind: "terminal",
      mode: row.mode as TerminalActivationTarget["mode"],
      notifyLeaseMs: Number(row.notify_lease_ms),
      runtimeKind: (row.runtime_kind ? String(row.runtime_kind) : "unknown") as TerminalActivationTarget["runtimeKind"],
      runtimeSessionId: row.runtime_session_id ? String(row.runtime_session_id) : null,
      backend: row.backend as TerminalActivationTarget["backend"],
      tmuxPaneId: row.tmux_pane_id ? String(row.tmux_pane_id) : null,
      tty: row.tty ? String(row.tty) : null,
      termProgram: row.term_program ? String(row.term_program) : null,
      itermSessionId: row.iterm_session_id ? String(row.iterm_session_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastSeenAt: String(row.last_seen_at),
    };
  }

  private mapActivationDispatchState(row: Record<string, unknown>): ActivationDispatchState {
    return {
      agentId: String(row.agent_id),
      targetId: String(row.target_id),
      status: row.status as ActivationDispatchState["status"],
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      pendingNewItemCount: Number(row.pending_new_item_count),
      pendingSummary: row.pending_summary ? String(row.pending_summary) : null,
      pendingSubscriptionIds: parseJson<string[]>(row.pending_subscription_ids_json as string),
      pendingSourceIds: parseJson<string[]>(row.pending_source_ids_json as string),
      updatedAt: String(row.updated_at),
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
        ? parseJson<InboxItem["deliveryHandle"]>(row.delivery_handle_json as string)
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
      targetId: String(row.target_id),
      targetKind: row.target_kind as Activation["targetKind"],
      subscriptionIds: parseJson<string[]>(row.subscription_ids_json as string),
      sourceIds: parseJson<string[]>(row.source_ids_json as string),
      newItemCount: Number(row.new_item_count),
      summary: String(row.summary),
      items: row.items_json ? parseJson<Activation["items"]>(row.items_json as string) : undefined,
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
