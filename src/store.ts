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
  ActivationDispatchState,
  ActivationTarget,
  AddWebhookActivationTargetInput,
  Agent,
  AppendSourceEventInput,
  AppendSourceEventResult,
  CleanupPolicy,
  DeliveryAttempt,
  Inbox,
  InboxAggregationPolicy,
  InboxEntry,
  InboxItem,
  ListInboxItemsOptions,
  NotificationGrouping,
  AgentTimer,
  RegisterAgentInput,
  SourceHost,
  SourceIdleState,
  Subscription,
  SubscriptionLifecycleRetirement,
  SubscriptionFilter,
  SubscriptionSource,
  SubscriptionStartPolicy,
  TerminalActivationTarget,
  WebhookActivationTarget,
} from "./model";
import { formatEntryRef, formatThreadRef, generateCanonicalId, nowIso, parseEntryRef } from "./util";

const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const V1_BASELINE_TAG = "0000_v1_initial";
type SqlBindParams = unknown[];

interface SqlMigration {
  tag: string;
  sql: string;
}

interface DigestThreadRecord {
  threadId: string;
  inboxId: string;
  sourceId: string;
  groupKey: string;
  resourceRef: string | null;
  eventFamily: string | null;
  latestRevision: number;
  latestEntryId: string | null;
  status: "open" | "closed";
  summary: string;
  firstItemAt: string;
  lastItemAt: string;
  flushAfterAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseJson<T>(value: string | null): T {
  if (!value) {
    return {} as T;
  }
  return JSON.parse(value) as T;
}

function earlierLifecycleRetirement(
  left: SubscriptionLifecycleRetirement,
  right: SubscriptionLifecycleRetirement,
): SubscriptionLifecycleRetirement {
  const leftAt = Date.parse(left.retireAt);
  const rightAt = Date.parse(right.retireAt);
  if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt <= rightAt) {
    return {
      ...left,
      updatedAt: right.updatedAt,
    };
  }
  return right;
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
    let db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();
    let store = new AgentInboxStore(dbPath, db);
    if (fs.existsSync(dbPath) && store.shouldArchivePreV1Database()) {
      const archivedPath = store.archivePreV1Database();
      console.warn(
        `[agentinbox] archived pre-v1 local database to ${archivedPath}; starting with a fresh v1 database (no data imported).`,
      );
      db = new SQL.Database();
      store = new AgentInboxStore(dbPath, db);
    }
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

  save(): void {
    this.persist();
  }

  private migrate(): void {
    const migrations = this.loadSqlMigrations();
    this.ensureDrizzleMigrationsTable();
    const applied = this.listAppliedMigrationTags();

    const pending = migrations.filter((migration) => !applied.has(migration.tag));
    for (const migration of pending) {
      this.applyMigration(migration);
    }

    this.ensureInboxEntryBackfill();

    this.setUserVersion(migrations.length);
  }

  private loadSqlMigrations(): SqlMigration[] {
    const migrationsDir = this.resolveMigrationsDir();
    const files = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (files.length === 0) {
      throw new Error(`no SQL migrations found in ${migrationsDir}`);
    }
    return files.map((name) => ({
      tag: name.replace(/\.sql$/, ""),
      sql: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
    }));
  }

  private resolveMigrationsDir(): string {
    const candidates = [
      path.resolve(__dirname, "../drizzle/migrations"),
      path.resolve(__dirname, "../../drizzle/migrations"),
      path.resolve(process.cwd(), "drizzle/migrations"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(`cannot locate drizzle migrations directory from ${__dirname}`);
  }

  private ensureDrizzleMigrationsTable(): void {
    this.db.exec(`
      create table if not exists ${DRIZZLE_MIGRATIONS_TABLE} (
        id integer primary key autoincrement,
        tag text not null unique,
        applied_at text not null
      );
    `);
  }

  private listAppliedMigrationTags(): Set<string> {
    const rows = this.getAll(
      `select tag from ${DRIZZLE_MIGRATIONS_TABLE} order by id asc`,
    );
    return new Set(rows.map((row) => String(row.tag)));
  }

  private applyMigration(migration: SqlMigration): void {
    this.inTransaction(() => {
      this.db.exec(migration.sql);
      this.recordAppliedMigration(migration.tag);
    });
  }

  private recordAppliedMigration(tag: string): void {
    this.db.run(
      `insert or ignore into ${DRIZZLE_MIGRATIONS_TABLE} (tag, applied_at) values (?, ?)`,
      [tag, nowIso()],
    );
  }

  private shouldArchivePreV1Database(): boolean {
    if (this.isV1Database()) {
      return false;
    }
    return this.hasRecognizablePreV1Schema();
  }

  private isV1Database(): boolean {
    if (!this.tableExists(DRIZZLE_MIGRATIONS_TABLE)) {
      return false;
    }
    const applied = this.listAppliedMigrationTags();
    if (!applied.has(V1_BASELINE_TAG)) {
      return false;
    }
    return this.tableExists("source_hosts")
      && this.tableExists("inbox_entries")
      && this.tableExists("digest_threads")
      && this.columnExists("activation_dispatch_states", "pending_fingerprint")
      && this.columnType("inbox_entries", "entry_id") === "text"
      && this.columnType("digest_threads", "thread_id") === "text";
  }

  private hasRecognizablePreV1Schema(): boolean {
    return this.tableExists("sources")
      || this.tableExists("agents")
      || this.tableExists("subscriptions")
      || this.tableExists("activation_targets")
      || this.tableExists("inbox_items")
      || this.tableExists(DRIZZLE_MIGRATIONS_TABLE);
  }

  private archivePreV1Database(): string {
    this.close();
    const archivedPath = this.nextArchivedDatabasePath();
    fs.renameSync(this.dbPath, archivedPath);
    return archivedPath;
  }

  private nextArchivedDatabasePath(): string {
    const safeStamp = nowIso().replace(/[:.]/g, "-");
    const base = `${this.dbPath}.pre-v1.${safeStamp}.bak`;
    if (!fs.existsSync(base)) {
      return base;
    }
    let suffix = 1;
    while (fs.existsSync(`${base}.${suffix}`)) {
      suffix += 1;
    }
    return `${base}.${suffix}`;
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

  private columnType(tableName: string, columnName: string): string | null {
    if (!this.tableExists(tableName)) {
      return null;
    }
    const rows = this.getAll(`pragma table_info(${tableName});`);
    const row = rows.find((entry) => String(entry.name) === columnName);
    return row ? String(row.type).toLowerCase() : null;
  }

  private ensureInboxEntryBackfill(): void {
    if (!this.tableExists("inbox_entries") || !this.tableExists("inbox_items")) {
      return;
    }
    const existing = this.getOne("select count(*) as count from inbox_entries");
    if (existing && Number(existing.count ?? 0) > 0) {
      return;
    }
    const rows = this.getAll(`
      select *
      from inbox_items
      order by inbox_id asc, coalesce(inbox_sequence, rowid) asc
    `);
    if (rows.length === 0) {
      return;
    }
    this.inTransaction(() => {
      for (const row of rows) {
        const item = this.mapInboxItem(row);
        const entryId = this.insertInboxEntryRecord({
          inboxId: item.inboxId,
          kind: "item",
          threadId: null,
          revision: null,
          groupKey: null,
          resourceRef: null,
          eventFamily: null,
          itemJson: JSON.stringify({
            itemId: item.itemId,
            sourceId: item.sourceId,
            sourceNativeId: item.sourceNativeId,
            eventVariant: item.eventVariant,
            inboxId: item.inboxId,
            occurredAt: item.occurredAt,
            metadata: item.metadata,
            rawPayload: item.rawPayload,
            deliveryHandle: item.deliveryHandle ?? null,
          }),
          count: 1,
          summary: summarizeBackfilledItemEntry(item),
          firstItemAt: item.occurredAt,
          lastItemAt: item.occurredAt,
          sourceIdsJson: JSON.stringify([item.sourceId]),
          subscriptionIdsJson: JSON.stringify([]),
          deliveryHandleJson: item.deliveryHandle ? JSON.stringify(item.deliveryHandle) : null,
          ackedAt: item.ackedAt ?? null,
          supersededAt: null,
          createdAt: item.occurredAt,
        });
        this.db.run(
          "insert or ignore into inbox_entry_items (entry_id, item_id) values (?, ?)",
          [entryId, item.itemId],
        );
      }
    });
  }

  getSourceHostByKey(hostType: string, hostKey: string): SourceHost | null {
    const row = this.getOne(
      "select * from source_hosts where host_type = ? and host_key = ?",
      [hostType, hostKey],
    );
    return row ? this.mapSourceHost(row) : null;
  }

  getSourceHost(hostId: string): SourceHost | null {
    const row = this.getOne("select * from source_hosts where host_id = ?", [hostId]);
    return row ? this.mapSourceHost(row) : null;
  }

  insertSourceHost(host: SourceHost): void {
    this.db.run(
      `
      insert into source_hosts (
        host_id, host_type, host_key, config_ref, config_json, status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        host.hostId,
        host.hostType,
        host.hostKey,
        host.configRef ?? null,
        JSON.stringify(host.config ?? {}),
        host.status,
        host.createdAt,
        host.updatedAt,
      ],
    );
    this.persist();
  }

  listSourceHosts(): SourceHost[] {
    const rows = this.getAll("select * from source_hosts order by created_at asc");
    return rows.map((row) => this.mapSourceHost(row));
  }

  updateSourceHostDefinition(
    hostId: string,
    input: { configRef?: string | null; config?: Record<string, unknown> },
  ): SourceHost {
    const current = this.getSourceHost(hostId);
    if (!current) {
      throw new Error(`unknown source host: ${hostId}`);
    }
    this.db.run(
      `
      update source_hosts
      set config_ref = ?, config_json = ?, updated_at = ?
      where host_id = ?
    `,
      [
        Object.prototype.hasOwnProperty.call(input, "configRef") ? input.configRef ?? null : current.configRef ?? null,
        JSON.stringify(Object.prototype.hasOwnProperty.call(input, "config") ? input.config ?? {} : current.config ?? {}),
        nowIso(),
        hostId,
      ],
    );
    this.persist();
    return this.getSourceHost(hostId)!;
  }

  updateSourceHostRuntime(
    hostId: string,
    input: { status?: SourceHost["status"] },
  ): void {
    const current = this.getSourceHost(hostId);
    if (!current) {
      throw new Error(`unknown source host: ${hostId}`);
    }
    this.db.run(
      `
      update source_hosts
      set status = ?, updated_at = ?
      where host_id = ?
    `,
      [
        Object.prototype.hasOwnProperty.call(input, "status") ? input.status ?? current.status : current.status,
        nowIso(),
        hostId,
      ],
    );
    this.persist();
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
    this.inTransaction(() => {
      const hostId = source.hostId ?? this.ensureCompatibilityHostForSource(source);
      const streamKind = source.streamKind ?? "default";
      const streamKey = source.streamKey ?? source.sourceKey;
      this.db.run(
        `
        insert into sources (
          source_id, host_id, stream_kind, stream_key, compat_source_type,
          source_type, source_key, config_ref, config_json,
          status, checkpoint, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          source.sourceId,
          hostId,
          streamKind,
          streamKey,
          source.compatSourceType ?? null,
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
    });
    this.persist();
  }

  listSources(): SubscriptionSource[] {
    const rows = this.getAll("select * from sources order by created_at asc");
    return rows.map((row) => this.mapSource(row));
  }

  getSourceIdleState(sourceId: string): SourceIdleState | null {
    const row = this.getOne("select * from source_idle_states where source_id = ?", [sourceId]);
    return row ? this.mapSourceIdleState(row) : null;
  }

  listSourceIdleStatesDue(cutoffIso: string): SourceIdleState[] {
    const rows = this.getAll(
      "select * from source_idle_states where auto_pause_at <= ? and auto_paused_at is null order by auto_pause_at asc",
      [cutoffIso],
    );
    return rows.map((row) => this.mapSourceIdleState(row));
  }

  upsertSourceIdleState(idleState: SourceIdleState): SourceIdleState {
    this.db.run(
      `
      insert into source_idle_states (
        source_id, idle_since, auto_pause_at, auto_paused_at, updated_at
      ) values (?, ?, ?, ?, ?)
      on conflict(source_id) do update set
        idle_since = excluded.idle_since,
        auto_pause_at = excluded.auto_pause_at,
        auto_paused_at = excluded.auto_paused_at,
        updated_at = excluded.updated_at
    `,
      [
        idleState.sourceId,
        idleState.idleSince,
        idleState.autoPauseAt,
        idleState.autoPausedAt ?? null,
        idleState.updatedAt,
      ],
    );
    this.persist();
    return this.getSourceIdleState(idleState.sourceId)!;
  }

  deleteSourceIdleState(sourceId: string): void {
    this.db.run("delete from source_idle_states where source_id = ?", [sourceId]);
    this.persist();
  }

  updateSourceDefinition(
    sourceId: string,
    input: { configRef?: string | null; config?: Record<string, unknown> },
  ): SubscriptionSource {
    const current = this.getSource(sourceId);
    if (!current) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    this.db.run(
      `
      update sources
      set config_ref = ?, config_json = ?, updated_at = ?
      where source_id = ?
    `,
      [
        Object.prototype.hasOwnProperty.call(input, "configRef") ? input.configRef ?? null : current.configRef ?? null,
        JSON.stringify(Object.prototype.hasOwnProperty.call(input, "config") ? input.config ?? {} : current.config ?? {}),
        nowIso(),
        sourceId,
      ],
    );
    this.persist();
    return this.getSource(sourceId)!;
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
        Object.prototype.hasOwnProperty.call(input, "status") ? input.status ?? current.status : current.status,
        Object.prototype.hasOwnProperty.call(input, "checkpoint") ? input.checkpoint ?? null : current.checkpoint ?? null,
        nowIso(),
        sourceId,
      ],
    );
    this.persist();
  }

  deleteSource(sourceId: string): SubscriptionSource | null {
    const source = this.getSource(sourceId);
    if (!source) {
      return null;
    }
    this.inTransaction(() => {
      const stream = this.getStreamBySourceId(sourceId);
      if (stream) {
        const consumers = this.getAll(
          "select consumer_id from consumers where stream_id = ?",
          [stream.streamId],
        );
        for (const row of consumers) {
          const consumerId = String(row.consumer_id);
          this.db.run("delete from consumer_commits where consumer_id = ?", [consumerId]);
        }
        this.db.run("delete from consumers where stream_id = ?", [stream.streamId]);
        this.db.run("delete from stream_events where stream_id = ?", [stream.streamId]);
        this.db.run("delete from streams where stream_id = ?", [stream.streamId]);
      }
      this.db.run("delete from source_idle_states where source_id = ?", [sourceId]);
      this.db.run("delete from sources where source_id = ?", [sourceId]);
      const hostId = source.hostId ?? null;
      const siblings = hostId
        ? this.getOne("select count(*) as count from sources where host_id = ?", [hostId])
        : null;
      if (hostId && Number(siblings?.count ?? 0) === 0) {
        this.db.run("delete from source_hosts where host_id = ?", [hostId]);
      }
    });
    this.persist();
    return source;
  }

  getAgent(agentId: string): Agent | null {
    const row = this.getOne("select * from agents where agent_id = ?", [agentId]);
    return row ? this.mapAgent(row) : null;
  }

  insertAgent(agent: Agent): void {
    this.db.run(
      `
      insert into agents (
        agent_id, status, offline_since, runtime_kind, runtime_session_id, created_at, updated_at, last_seen_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        agent.agentId,
        agent.status,
        agent.offlineSince ?? null,
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
    status?: Agent["status"];
    offlineSince?: string | null;
    runtimeKind: Agent["runtimeKind"];
    runtimeSessionId?: string | null;
    updatedAt: string;
    lastSeenAt: string;
  }): Agent {
    const current = this.getAgent(agentId);
    if (!current) {
      throw new Error(`unknown agent: ${agentId}`);
    }
    this.db.run(
      `
      update agents
      set status = ?, offline_since = ?, runtime_kind = ?, runtime_session_id = ?, updated_at = ?, last_seen_at = ?
      where agent_id = ?
    `,
      [
        input.status ?? current.status,
        input.offlineSince !== undefined ? input.offlineSince : current.offlineSince ?? null,
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
      `
      insert into inboxes (
        inbox_id, owner_agent_id, aggregation_enabled, aggregation_window_ms,
        aggregation_max_items, aggregation_max_thread_age_ms, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        inbox.inboxId,
        inbox.ownerAgentId,
        inbox.aggregationEnabled ? 1 : 0,
        inbox.aggregationWindowMs ?? null,
        inbox.aggregationMaxItems ?? null,
        inbox.aggregationMaxThreadAgeMs ?? null,
        inbox.createdAt,
      ],
    );
    this.persist();
  }

  updateInboxAggregationPolicy(inboxId: string, policy: InboxAggregationPolicy): Inbox {
    const current = this.getInbox(inboxId);
    if (!current) {
      throw new Error(`unknown inbox: ${inboxId}`);
    }
    this.db.run(
      `
      update inboxes
      set aggregation_enabled = ?,
          aggregation_window_ms = ?,
          aggregation_max_items = ?,
          aggregation_max_thread_age_ms = ?
      where inbox_id = ?
      `,
      [
        policy.enabled === undefined ? (current.aggregationEnabled ? 1 : 0) : (policy.enabled ? 1 : 0),
        Object.prototype.hasOwnProperty.call(policy, "windowMs") ? policy.windowMs ?? null : current.aggregationWindowMs ?? null,
        Object.prototype.hasOwnProperty.call(policy, "maxItems") ? policy.maxItems ?? null : current.aggregationMaxItems ?? null,
        Object.prototype.hasOwnProperty.call(policy, "maxThreadAgeMs") ? policy.maxThreadAgeMs ?? null : current.aggregationMaxThreadAgeMs ?? null,
        inboxId,
      ],
    );
    this.persist();
    return this.getInbox(inboxId)!;
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
        subscription_id, agent_id, source_id, filter_json, tracked_resource_ref, cleanup_policy_json, start_policy, start_offset, start_time, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        subscription.subscriptionId,
        subscription.agentId,
        subscription.sourceId,
        JSON.stringify(subscription.filter),
        subscription.trackedResourceRef ?? null,
        JSON.stringify(subscription.cleanupPolicy),
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

  deleteSubscription(subscriptionId: string): Subscription | null {
    const subscription = this.getSubscription(subscriptionId);
    if (!subscription) {
      return null;
    }
    this.inTransaction(() => {
      this.db.run(
        "delete from consumer_commits where consumer_id in (select consumer_id from consumers where subscription_id = ?)",
        [subscriptionId],
      );
      this.db.run("delete from consumers where subscription_id = ?", [subscriptionId]);
      this.db.run("delete from subscription_lifecycle_retirements where subscription_id = ?", [subscriptionId]);
      this.db.run("delete from subscriptions where subscription_id = ?", [subscriptionId]);
    });
    this.persist();
    return subscription;
  }

  getSubscriptionLifecycleRetirement(subscriptionId: string): SubscriptionLifecycleRetirement | null {
    const row = this.getOne(
      "select * from subscription_lifecycle_retirements where subscription_id = ?",
      [subscriptionId],
    );
    return row ? this.mapSubscriptionLifecycleRetirement(row) : null;
  }

  listSubscriptionLifecycleRetirements(): SubscriptionLifecycleRetirement[] {
    const rows = this.getAll("select * from subscription_lifecycle_retirements order by retire_at asc, created_at asc");
    return rows.map((row) => this.mapSubscriptionLifecycleRetirement(row));
  }

  listSubscriptionLifecycleRetirementsDue(cutoffIso: string): SubscriptionLifecycleRetirement[] {
    const rows = this.getAll(
      "select * from subscription_lifecycle_retirements where retire_at <= ? order by retire_at asc, created_at asc",
      [cutoffIso],
    );
    return rows.map((row) => this.mapSubscriptionLifecycleRetirement(row));
  }

  upsertSubscriptionLifecycleRetirement(retirement: SubscriptionLifecycleRetirement): SubscriptionLifecycleRetirement {
    const existing = this.getSubscriptionLifecycleRetirement(retirement.subscriptionId);
    const next = existing
      ? earlierLifecycleRetirement(existing, retirement)
      : retirement;
    this.db.run(
      `
      insert into subscription_lifecycle_retirements (
        subscription_id, source_id, tracked_resource_ref, retire_at, terminal_state, terminal_result, terminal_occurred_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(subscription_id) do update set
        source_id = excluded.source_id,
        tracked_resource_ref = excluded.tracked_resource_ref,
        retire_at = excluded.retire_at,
        terminal_state = excluded.terminal_state,
        terminal_result = excluded.terminal_result,
        terminal_occurred_at = excluded.terminal_occurred_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
      [
        next.subscriptionId,
        next.sourceId,
        next.trackedResourceRef,
        next.retireAt,
        next.terminalState ?? null,
        next.terminalResult ?? null,
        next.terminalOccurredAt ?? null,
        next.createdAt,
        next.updatedAt,
      ],
    );
    this.persist();
    return this.getSubscriptionLifecycleRetirement(retirement.subscriptionId)!;
  }

  deleteSubscriptionLifecycleRetirement(subscriptionId: string): void {
    this.db.run("delete from subscription_lifecycle_retirements where subscription_id = ?", [subscriptionId]);
    this.persist();
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
          target_id, agent_id, kind, status, offline_since, consecutive_failures, last_delivered_at, last_error,
          mode, notify_lease_ms, min_unacked_items, url, created_at, updated_at, last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          target.targetId,
          target.agentId,
          target.kind,
          target.status,
          target.offlineSince ?? null,
          target.consecutiveFailures,
          target.lastDeliveredAt ?? null,
          target.lastError ?? null,
          target.mode,
          target.notifyLeaseMs,
          target.minUnackedItems ?? null,
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
          target_id, agent_id, kind, status, offline_since, consecutive_failures, last_delivered_at, last_error, mode, notify_lease_ms, min_unacked_items,
          runtime_kind, runtime_session_id, runtime_pid, backend, tmux_pane_id, tty, term_program, iterm_session_id,
          created_at, updated_at, last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          target.targetId,
          target.agentId,
          target.kind,
          target.status,
          target.offlineSince ?? null,
          target.consecutiveFailures,
          target.lastDeliveredAt ?? null,
          target.lastError ?? null,
          target.mode,
          target.notifyLeaseMs,
          target.minUnackedItems ?? null,
          target.runtimeKind,
          target.runtimeSessionId ?? null,
          target.runtimePid ?? null,
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
      runtimePid?: number | null;
      tmuxPaneId?: string | null;
      tty?: string | null;
      termProgram?: string | null;
      itermSessionId?: string | null;
      notifyLeaseMs: number;
      minUnackedItems: number | null;
      updatedAt: string;
      lastSeenAt: string;
    },
  ): TerminalActivationTarget {
    this.db.run(
      `
      update activation_targets
      set status = 'active', offline_since = null, last_error = null, consecutive_failures = 0,
          runtime_kind = ?, runtime_session_id = ?, runtime_pid = ?, tmux_pane_id = ?, tty = ?, term_program = ?, iterm_session_id = ?, notify_lease_ms = ?, min_unacked_items = ?, updated_at = ?, last_seen_at = ?
      where target_id = ? and kind = 'terminal'
    `,
      [
        input.runtimeKind,
        input.runtimeSessionId ?? null,
        input.runtimePid ?? null,
        input.tmuxPaneId ?? null,
        input.tty ?? null,
        input.termProgram ?? null,
        input.itermSessionId ?? null,
        input.notifyLeaseMs,
        input.minUnackedItems,
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

  updateActivationTargetRuntime(
    targetId: string,
    input: {
      status?: ActivationTarget["status"];
      offlineSince?: string | null;
      consecutiveFailures?: number;
      lastDeliveredAt?: string | null;
      lastError?: string | null;
      updatedAt: string;
      lastSeenAt?: string;
    },
  ): ActivationTarget {
    const current = this.getActivationTarget(targetId);
    if (!current) {
      throw new Error(`unknown activation target: ${targetId}`);
    }
    this.db.run(
      `
      update activation_targets
      set status = ?, offline_since = ?, consecutive_failures = ?, last_delivered_at = ?, last_error = ?, updated_at = ?, last_seen_at = ?
      where target_id = ?
    `,
      [
        input.status ?? current.status,
        input.offlineSince !== undefined ? input.offlineSince : current.offlineSince ?? null,
        input.consecutiveFailures ?? current.consecutiveFailures,
        input.lastDeliveredAt !== undefined ? input.lastDeliveredAt : current.lastDeliveredAt ?? null,
        input.lastError !== undefined ? input.lastError : current.lastError ?? null,
        input.updatedAt,
        input.lastSeenAt ?? current.lastSeenAt,
        targetId,
      ],
    );
    this.persist();
    return this.getActivationTarget(targetId)!;
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

  deleteAgent(agentId: string, options?: { persist?: boolean }): void {
    const inbox = this.getInboxByAgentId(agentId);
    const subscriptions = this.listSubscriptionsForAgent(agentId);
    this.inTransaction(() => {
      for (const subscription of subscriptions) {
        this.db.run("delete from consumer_commits where consumer_id in (select consumer_id from consumers where subscription_id = ?)", [
          subscription.subscriptionId,
        ]);
        this.db.run("delete from consumers where subscription_id = ?", [subscription.subscriptionId]);
      }
      this.db.run(
        "delete from subscription_lifecycle_retirements where subscription_id in (select subscription_id from subscriptions where agent_id = ?)",
        [agentId],
      );
      this.db.run(
        "delete from source_idle_states where source_id in (select distinct source_id from subscriptions where agent_id = ?)",
        [agentId],
      );
      this.db.run("delete from timers where agent_id = ?", [agentId]);
      this.db.run("delete from subscriptions where agent_id = ?", [agentId]);
      this.db.run("delete from activation_dispatch_states where agent_id = ?", [agentId]);
      this.db.run("delete from activation_targets where agent_id = ?", [agentId]);
      if (inbox) {
        this.db.run("delete from inbox_items where inbox_id = ?", [inbox.inboxId]);
        this.db.run("delete from activations where agent_id = ? or inbox_id = ?", [agentId, inbox.inboxId]);
        this.db.run("delete from inboxes where inbox_id = ?", [inbox.inboxId]);
      } else {
        this.db.run("delete from activations where agent_id = ?", [agentId]);
      }
      this.db.run("delete from agents where agent_id = ?", [agentId]);
    });
    if (options?.persist !== false) {
      this.persist();
    }
  }

  countActiveActivationTargetsForAgent(agentId: string): number {
    const row = this.getOne(
      "select count(*) as count from activation_targets where agent_id = ? and status = 'active'",
      [agentId],
    );
    return Number(row?.count ?? 0);
  }

  listOfflineAgentsOlderThan(cutoffIso: string): Agent[] {
    const rows = this.getAll(
      "select * from agents where status = 'offline' and offline_since is not null and offline_since <= ? order by offline_since asc",
      [cutoffIso],
    );
    return rows.map((row) => this.mapAgent(row));
  }

  insertTimer(timer: AgentTimer): void {
    this.db.run(
      `
      insert into timers (
        schedule_id, agent_id, status, mode, at, interval_ms, cron_expr, timezone,
        message, sender, next_fire_at, last_fired_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        timer.scheduleId,
        timer.agentId,
        timer.status,
        timer.mode,
        timer.at ?? null,
        timer.intervalMs ?? null,
        timer.cronExpr ?? null,
        timer.timezone,
        timer.message,
        timer.sender ?? null,
        timer.nextFireAt ?? null,
        timer.lastFiredAt ?? null,
        timer.createdAt,
        timer.updatedAt,
      ],
    );
    this.persist();
  }

  getTimer(scheduleId: string): AgentTimer | null {
    const row = this.getOne("select * from timers where schedule_id = ?", [scheduleId]);
    return row ? this.mapTimer(row) : null;
  }

  listTimers(): AgentTimer[] {
    const rows = this.getAll("select * from timers order by created_at asc");
    return rows.map((row) => this.mapTimer(row));
  }

  listTimersForAgent(agentId: string): AgentTimer[] {
    const rows = this.getAll("select * from timers where agent_id = ? order by created_at asc", [agentId]);
    return rows.map((row) => this.mapTimer(row));
  }

  listDueTimers(cutoffIso: string): AgentTimer[] {
    const rows = this.getAll(
      "select * from timers where status = 'active' and next_fire_at is not null and next_fire_at <= ? order by next_fire_at asc, schedule_id asc",
      [cutoffIso],
    );
    return rows.map((row) => this.mapTimer(row));
  }

  getNearestActiveTimer(): AgentTimer | null {
    const row = this.getOne(
      "select * from timers where status = 'active' and next_fire_at is not null order by next_fire_at asc, schedule_id asc limit 1",
    );
    return row ? this.mapTimer(row) : null;
  }

  updateTimer(scheduleId: string, input: Partial<Omit<AgentTimer, "scheduleId" | "agentId" | "createdAt">>): AgentTimer {
    const current = this.getTimer(scheduleId);
    if (!current) {
      throw new Error(`unknown timer: ${scheduleId}`);
    }
    this.db.run(
      `
      update timers
      set status = ?, mode = ?, at = ?, interval_ms = ?, cron_expr = ?, timezone = ?,
          message = ?, sender = ?, next_fire_at = ?, last_fired_at = ?, updated_at = ?
      where schedule_id = ?
    `,
      [
        input.status ?? current.status,
        input.mode ?? current.mode,
        input.at !== undefined ? input.at ?? null : current.at ?? null,
        input.intervalMs !== undefined ? input.intervalMs ?? null : current.intervalMs ?? null,
        input.cronExpr !== undefined ? input.cronExpr ?? null : current.cronExpr ?? null,
        input.timezone ?? current.timezone,
        input.message ?? current.message,
        input.sender !== undefined ? input.sender ?? null : current.sender ?? null,
        input.nextFireAt !== undefined ? input.nextFireAt ?? null : current.nextFireAt ?? null,
        input.lastFiredAt !== undefined ? input.lastFiredAt ?? null : current.lastFiredAt ?? null,
        input.updatedAt ?? current.updatedAt,
        scheduleId,
      ],
    );
    this.persist();
    return this.getTimer(scheduleId)!;
  }

  deleteTimer(scheduleId: string): AgentTimer | null {
    const current = this.getTimer(scheduleId);
    if (!current) {
      return null;
    }
    this.db.run("delete from timers where schedule_id = ?", [scheduleId]);
    this.persist();
    return current;
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
        agent_id, target_id, status, lease_expires_at, last_notified_fingerprint, defer_reason, defer_attempts,
        first_deferred_at, last_deferred_at, pending_fingerprint, pending_new_item_count, pending_summary,
        pending_subscription_ids_json, pending_source_ids_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(agent_id, target_id) do update set
        status = excluded.status,
        lease_expires_at = excluded.lease_expires_at,
        last_notified_fingerprint = excluded.last_notified_fingerprint,
        defer_reason = excluded.defer_reason,
        defer_attempts = excluded.defer_attempts,
        first_deferred_at = excluded.first_deferred_at,
        last_deferred_at = excluded.last_deferred_at,
        pending_fingerprint = excluded.pending_fingerprint,
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
        state.lastNotifiedFingerprint ?? null,
        state.deferReason ?? null,
        state.deferAttempts,
        state.firstDeferredAt ?? null,
        state.lastDeferredAt ?? null,
        state.pendingFingerprint ?? null,
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
      const rowId = this.lastInsertRowId();
      this.db.run(
        `
        update inbox_items
        set inbox_sequence = ?
        where rowid = ? and inbox_sequence is null
      `,
        [rowId, rowId],
      );
      this.persist();
    }
    return inserted;
  }

  createInboxItemEntry(
    inboxId: string,
    item: InboxItem,
    input: {
      summary: string;
      subscriptionIds: string[];
    },
  ): InboxEntry {
    const entryId = this.insertInboxEntryRecord({
      inboxId,
      kind: "item",
      threadId: null,
      revision: null,
      groupKey: null,
      resourceRef: null,
      eventFamily: null,
      itemJson: JSON.stringify({
        itemId: item.itemId,
        sourceId: item.sourceId,
        sourceNativeId: item.sourceNativeId,
        eventVariant: item.eventVariant,
        inboxId: item.inboxId,
        occurredAt: item.occurredAt,
        metadata: item.metadata,
        rawPayload: item.rawPayload,
        deliveryHandle: item.deliveryHandle ?? null,
      }),
      count: 1,
      summary: input.summary,
      firstItemAt: item.occurredAt,
      lastItemAt: item.occurredAt,
      sourceIdsJson: JSON.stringify([item.sourceId]),
      subscriptionIdsJson: JSON.stringify(uniqueSorted(input.subscriptionIds)),
      deliveryHandleJson: item.deliveryHandle ? JSON.stringify(item.deliveryHandle) : null,
      ackedAt: item.ackedAt ?? null,
      supersededAt: null,
      createdAt: nowIso(),
    });
    this.db.run(
      "insert or ignore into inbox_entry_items (entry_id, item_id) values (?, ?)",
      [entryId, item.itemId],
    );
    this.persist();
    return this.getInboxEntry(entryId)!;
  }

  listInboxEntries(inboxId: string, options?: ListInboxItemsOptions): InboxEntry[] {
    const includeAcked = options?.includeAcked ?? false;
    const filters = ["inbox_id = ?"];
    const params: Array<string | number | null> = [inboxId];
    if (!includeAcked) {
      filters.push("acked_at is null");
      filters.push("superseded_at is null");
    }
    if (options?.afterEntryId) {
      const anchor = this.getOne(
        "select sequence from inbox_entries where inbox_id = ? and entry_id = ?",
        [inboxId, parseEntryRef(options.afterEntryId)],
      );
      if (!anchor) {
        throw new Error(`unknown inbox entry: ${options.afterEntryId}`);
      }
      filters.push("sequence > ?");
      params.push(Number(anchor.sequence));
    } else if (options?.afterItemId) {
      const anchor = this.getOne(
        `
        select ie.sequence
        from inbox_entries ie
        join inbox_entry_items iei on iei.entry_id = ie.entry_id
        where ie.inbox_id = ?
          and iei.item_id = ?
        order by ie.sequence desc
        limit 1
        `,
        [inboxId, options.afterItemId],
      );
      if (!anchor) {
        throw new Error(`unknown inbox item: ${options.afterItemId}`);
      }
      filters.push("sequence > ?");
      params.push(Number(anchor.sequence));
    }
    const rows = this.getAll(
      `select * from inbox_entries where ${filters.join(" and ")} order by sequence asc`,
      params,
    );
    return this.mapInboxEntries(rows);
  }

  getInboxEntry(entryId: string): InboxEntry | null {
    const rows = this.getAll("select * from inbox_entries where entry_id = ?", [parseEntryRef(entryId)]);
    return this.mapInboxEntries(rows)[0] ?? null;
  }

  ackInboxEntries(inboxId: string, entryIds: string[], ackedAt: string): { ackedEntries: number; ackedItems: number } {
    const resolvedIds = uniqueSorted(entryIds).map((entryId) => this.resolveInboxEntryId(inboxId, entryId));
    const itemIds = this.getRawItemIdsForEntryIds(resolvedIds);
    const ackedItems = itemIds.length > 0 ? this.ackItems(inboxId, itemIds, ackedAt) : 0;
    if (ackedItems > 0) {
      this.syncInboxEntryAckState(inboxId, ackedAt);
    }
    const ackedEntries = this.countAckedEntries(resolvedIds, ackedAt);
    return { ackedEntries, ackedItems };
  }

  ackInboxEntriesThrough(inboxId: string, entryId: string, ackedAt: string): { ackedEntries: number; ackedItems: number } {
    const anchor = this.getOne(
      "select sequence from inbox_entries where inbox_id = ? and entry_id = ?",
      [inboxId, this.resolveInboxEntryId(inboxId, entryId)],
    );
    if (!anchor) {
      throw new Error(`unknown inbox entry: ${entryId}`);
    }
    const rows = this.getAll(
      `
      select entry_id
      from inbox_entries
      where inbox_id = ?
        and acked_at is null
        and superseded_at is null
        and sequence <= ?
      order by sequence asc
      `,
      [inboxId, Number(anchor.sequence)],
    );
    return this.ackInboxEntries(inboxId, rows.map((row) => formatEntryRef(String(row.entry_id))), ackedAt);
  }

  getOpenDigestThread(inboxId: string, groupKey: string): DigestThreadRecord | null {
    const row = this.getOne(
      `
      select * from digest_threads
      where inbox_id = ? and group_key = ? and status = 'open'
      order by created_at desc, thread_id desc
      limit 1
      `,
      [inboxId, groupKey],
    );
    return row ? this.mapDigestThread(row) : null;
  }

  createDigestThread(input: {
    inboxId: string;
    sourceId: string;
    groupKey: string;
    resourceRef?: string | null;
    eventFamily?: string | null;
    summary: string;
    firstItemAt: string;
    flushAfterAt?: string | null;
    createdAt: string;
  }): DigestThreadRecord {
    this.db.run(
      `
      insert into digest_threads (
        thread_id, inbox_id, source_id, group_key, resource_ref, event_family, latest_revision,
        latest_entry_id, status, summary, first_item_at, last_item_at, flush_after_at,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, 0, null, 'open', ?, ?, ?, ?, ?, ?)
      `,
      (() => {
        const threadId = generateCanonicalId("thr");
        return [
          threadId,
        input.inboxId,
        input.sourceId,
        input.groupKey,
        input.resourceRef ?? null,
        input.eventFamily ?? null,
        input.summary,
        input.firstItemAt,
        input.firstItemAt,
        input.flushAfterAt ?? null,
        input.createdAt,
        input.createdAt,
        ];
      })(),
    );
    const threadId = String(this.getOne("select thread_id from digest_threads order by rowid desc limit 1")?.thread_id);
    this.persist();
    return this.getDigestThread(threadId)!;
  }

  getDigestThread(threadId: string): DigestThreadRecord | null {
    const row = this.getOne("select * from digest_threads where thread_id = ?", [threadId]);
    return row ? this.mapDigestThread(row) : null;
  }

  addItemToDigestThread(threadId: string, itemId: string, occurredAt: string, summary: string, flushAfterAt: string | null): DigestThreadRecord {
    this.inTransaction(() => {
      this.db.run(
        "insert or ignore into digest_thread_items (thread_id, item_id) values (?, ?)",
        [threadId, itemId],
      );
      this.db.run(
        `
        update digest_threads
        set summary = ?, last_item_at = ?, flush_after_at = ?, updated_at = ?
        where thread_id = ?
        `,
        [summary, occurredAt, flushAfterAt, nowIso(), threadId],
      );
    });
    this.persist();
    return this.getDigestThread(threadId)!;
  }

  listDueDigestThreads(now: string): DigestThreadRecord[] {
    const rows = this.getAll(
      `
      select *
      from digest_threads
      where status = 'open'
        and flush_after_at is not null
        and flush_after_at <= ?
      order by flush_after_at asc, created_at asc, thread_id asc
      `,
      [now],
    );
    return rows.map((row) => this.mapDigestThread(row));
  }

  listUnackedInboxItemsForDigestThread(threadId: string): InboxItem[] {
    const rows = this.getAll(
      `
      select i.*
      from digest_thread_items t
      join inbox_items i on i.item_id = t.item_id
      where t.thread_id = ?
        and i.acked_at is null
      order by coalesce(i.inbox_sequence, i.rowid) asc
      `,
      [threadId],
    );
    return rows.map((row) => this.mapInboxItem(row));
  }

  listOpenDigestThreadsForInbox(inboxId: string): DigestThreadRecord[] {
    const rows = this.getAll(
      "select * from digest_threads where inbox_id = ? and status = 'open' order by created_at asc, thread_id asc",
      [inboxId],
    );
    return rows.map((row) => this.mapDigestThread(row));
  }

  listOpenDigestThreads(): DigestThreadRecord[] {
    const rows = this.getAll(
      "select * from digest_threads where status = 'open' order by created_at asc, thread_id asc",
    );
    return rows.map((row) => this.mapDigestThread(row));
  }

  materializeDigestSnapshot(input: {
    threadId: string;
    inboxId: string;
    groupKey: string;
    resourceRef?: string | null;
    eventFamily?: string | null;
    summary: string;
    sourceIds: string[];
    subscriptionIds: string[];
    itemIds: string[];
    firstItemAt: string;
    lastItemAt: string;
    deliveryHandleJson?: string | null;
    createdAt: string;
  }): InboxEntry {
    const thread = this.getDigestThread(input.threadId);
    if (!thread) {
      throw new Error(`unknown digest thread: ${input.threadId}`);
    }
    this.inTransaction(() => {
      if (thread.latestEntryId != null) {
        this.db.run(
          "update inbox_entries set superseded_at = ? where entry_id = ? and superseded_at is null",
          [input.createdAt, thread.latestEntryId],
        );
      }
      const nextRevision = thread.latestRevision + 1;
      const entryId = this.insertInboxEntryRecord({
        inboxId: input.inboxId,
        kind: "digest_snapshot",
        threadId: input.threadId,
        revision: nextRevision,
        groupKey: input.groupKey,
        resourceRef: input.resourceRef ?? null,
        eventFamily: input.eventFamily ?? null,
        itemJson: null,
        count: input.itemIds.length,
        summary: input.summary,
        firstItemAt: input.firstItemAt,
        lastItemAt: input.lastItemAt,
        sourceIdsJson: JSON.stringify(uniqueSorted(input.sourceIds)),
        subscriptionIdsJson: JSON.stringify(uniqueSorted(input.subscriptionIds)),
        deliveryHandleJson: input.deliveryHandleJson ?? null,
        ackedAt: null,
        supersededAt: null,
        createdAt: input.createdAt,
      });
      for (const itemId of input.itemIds) {
        this.db.run(
          "insert or ignore into inbox_entry_items (entry_id, item_id) values (?, ?)",
          [entryId, itemId],
        );
      }
      this.db.run(
        `
        update digest_threads
        set latest_revision = ?, latest_entry_id = ?, summary = ?, first_item_at = ?, last_item_at = ?,
            flush_after_at = null, updated_at = ?
        where thread_id = ?
        `,
        [nextRevision, entryId, input.summary, input.firstItemAt, input.lastItemAt, input.createdAt, input.threadId],
      );
    });
    this.persist();
    return this.getInboxEntry(this.getDigestThread(input.threadId)!.latestEntryId!)!;
  }

  closeDigestThread(threadId: string, updatedAt: string): void {
    this.db.run(
      "update digest_threads set status = 'closed', flush_after_at = null, updated_at = ? where thread_id = ?",
      [updatedAt, threadId],
    );
    this.persist();
  }

  listDigestThreadsForRawItems(itemIds: string[]): DigestThreadRecord[] {
    if (itemIds.length === 0) {
      return [];
    }
    const placeholders = itemIds.map(() => "?").join(", ");
    const rows = this.getAll(
      `
      select distinct t.*
      from digest_threads t
      join digest_thread_items i on i.thread_id = t.thread_id
      where i.item_id in (${placeholders})
      order by t.created_at asc, t.thread_id asc
      `,
      itemIds,
    );
    return rows.map((row) => this.mapDigestThread(row));
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
        "select coalesce(inbox_sequence, rowid) as inbox_sequence from inbox_items where inbox_id = ? and item_id = ?",
        [inboxId, options.afterItemId],
      );
      if (!anchor) {
        throw new Error(`unknown inbox item: ${options.afterItemId}`);
      }
      filters.push("coalesce(inbox_sequence, rowid) > ?");
      params.push(Number(anchor.inbox_sequence));
    }

    const rows = this.getAll(
      `select * from inbox_items where ${filters.join(" and ")} order by coalesce(inbox_sequence, rowid) asc`,
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
      "select coalesce(inbox_sequence, rowid) as inbox_sequence from inbox_items where inbox_id = ? and item_id = ?",
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
        and coalesce(inbox_sequence, rowid) <= ?
    `,
      [ackedAt, inboxId, Number(anchor.inbox_sequence)],
    );
    const changes = this.changes();
    if (changes > 0) {
      this.persist();
    }
    return changes;
  }

  deleteAckedInboxItems(inboxId: string, olderThan: string): number {
    const itemIds = this.getAll(
      `
      select item_id
      from inbox_items
      where inbox_id = ?
        and acked_at is not null
        and acked_at < ?
      `,
      [inboxId, olderThan],
    ).map((row) => String(row.item_id));
    if (itemIds.length === 0) {
      return 0;
    }
    this.deleteInboxItemsAndEntryArtifacts(itemIds);
    return itemIds.length;
  }

  deleteAckedInboxItemsGlobal(olderThan: string): number {
    const itemIds = this.getAll(
      `
      select item_id
      from inbox_items
      where acked_at is not null
        and acked_at < ?
      `,
      [olderThan],
    ).map((row) => String(row.item_id));
    if (itemIds.length === 0) {
      return 0;
    }
    this.deleteInboxItemsAndEntryArtifacts(itemIds);
    return itemIds.length;
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
        activation.entries ? JSON.stringify(activation.entries) : (activation.items ? JSON.stringify(activation.items) : null),
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
        generateCanonicalId("evt"),
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

  deleteConsumer(consumerId: string): void {
    this.inTransaction(() => {
      this.db.run("delete from consumer_commits where consumer_id = ?", [consumerId]);
      this.db.run("delete from consumers where consumer_id = ?", [consumerId]);
    });
    this.persist();
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
        [generateCanonicalId("cmt"), consumerId, consumer.streamId, committedOffset, updatedAt],
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
      offlineAgents: this.count("agents where status = 'offline'"),
      subscriptions: this.count("subscriptions"),
      subscriptionLifecycleRetirements: this.count("subscription_lifecycle_retirements"),
      sourceIdleStates: this.count("source_idle_states"),
      inboxes: this.count("inboxes"),
      activationTargets: this.count("activation_targets"),
      offlineActivationTargets: this.count("activation_targets where status = 'offline'"),
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
    const hostId = requiredText(row, "host_id");
    const streamKind = requiredText(row, "stream_kind");
    const streamKey = requiredText(row, "stream_key");
    return {
      sourceId: String(row.source_id),
      streamId: String(row.source_id),
      hostId,
      streamKind,
      streamKey,
      compatSourceType: row.compat_source_type ? String(row.compat_source_type) as SubscriptionSource["compatSourceType"] : null,
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

  private ensureCompatibilityHostForSource(source: SubscriptionSource): string {
    const hostType = source.sourceType === "github_repo" || source.sourceType === "github_repo_ci"
      ? "github"
      : source.sourceType === "feishu_bot"
        ? "feishu"
        : source.sourceType === "local_event"
          ? "local_event"
          : "remote_source";
    const hostKey = source.sourceType === "github_repo" || source.sourceType === "github_repo_ci"
      ? `uxcAuth:${String((source.config ?? {}).uxcAuth ?? source.configRef ?? "default")}`
      : source.sourceType === "feishu_bot"
        ? `app:${String((source.config ?? {}).appId ?? source.configRef ?? source.sourceId)}`
        : source.sourceKey;
    const existing = this.getSourceHostByKey(hostType, hostKey);
    if (existing) {
      return existing.hostId;
    }
    const now = nowIso();
    const host: SourceHost = {
      hostId: generateCanonicalId("hst"),
      hostType: hostType as SourceHost["hostType"],
      hostKey,
      configRef: source.configRef ?? null,
      config: source.config ?? {},
      status: source.status,
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `
      insert into source_hosts (
        host_id, host_type, host_key, config_ref, config_json, status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        host.hostId,
        host.hostType,
        host.hostKey,
        host.configRef ?? null,
        JSON.stringify(host.config ?? {}),
        host.status,
        host.createdAt,
        host.updatedAt,
      ],
    );
    return host.hostId;
  }

  private mapSourceHost(row: Record<string, unknown>): SourceHost {
    return {
      hostId: String(row.host_id),
      hostType: String(row.host_type) as SourceHost["hostType"],
      hostKey: String(row.host_key),
      configRef: row.config_ref ? String(row.config_ref) : null,
      config: parseJson<Record<string, unknown>>(row.config_json as string),
      status: String(row.status) as SourceHost["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapSourceIdleState(row: Record<string, unknown>): SourceIdleState {
    return {
      sourceId: String(row.source_id),
      idleSince: String(row.idle_since),
      autoPauseAt: String(row.auto_pause_at),
      autoPausedAt: row.auto_paused_at ? String(row.auto_paused_at) : null,
      updatedAt: String(row.updated_at),
    };
  }

  private mapAgent(row: Record<string, unknown>): Agent {
    return {
      agentId: String(row.agent_id),
      status: row.status as Agent["status"],
      offlineSince: row.offline_since ? String(row.offline_since) : null,
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
      aggregationEnabled: Number(row.aggregation_enabled ?? 0) > 0,
      aggregationWindowMs: row.aggregation_window_ms == null ? null : Number(row.aggregation_window_ms),
      aggregationMaxItems: row.aggregation_max_items == null ? null : Number(row.aggregation_max_items),
      aggregationMaxThreadAgeMs: row.aggregation_max_thread_age_ms == null ? null : Number(row.aggregation_max_thread_age_ms),
      createdAt: String(row.created_at),
    };
  }

  private mapSubscription(row: Record<string, unknown>): Subscription {
    return {
      subscriptionId: String(row.subscription_id),
      agentId: String(row.agent_id),
      sourceId: String(row.source_id),
      filter: parseJson<SubscriptionFilter>(row.filter_json as string),
      trackedResourceRef: row.tracked_resource_ref ? String(row.tracked_resource_ref) : null,
      cleanupPolicy: parseJson<CleanupPolicy>(row.cleanup_policy_json as string),
      startPolicy: row.start_policy as SubscriptionStartPolicy,
      startOffset: row.start_offset != null ? Number(row.start_offset) : null,
      startTime: row.start_time ? String(row.start_time) : null,
      createdAt: String(row.created_at),
    };
  }

  private mapSubscriptionLifecycleRetirement(row: Record<string, unknown>): SubscriptionLifecycleRetirement {
    return {
      subscriptionId: String(row.subscription_id),
      sourceId: String(row.source_id),
      trackedResourceRef: String(row.tracked_resource_ref),
      retireAt: String(row.retire_at),
      terminalState: row.terminal_state ? String(row.terminal_state) : null,
      terminalResult: row.terminal_result ? String(row.terminal_result) : null,
      terminalOccurredAt: row.terminal_occurred_at ? String(row.terminal_occurred_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
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
        status: row.status as WebhookActivationTarget["status"],
        offlineSince: row.offline_since ? String(row.offline_since) : null,
        consecutiveFailures: Number(row.consecutive_failures ?? 0),
        lastDeliveredAt: row.last_delivered_at ? String(row.last_delivered_at) : null,
        lastError: row.last_error ? String(row.last_error) : null,
        mode: row.mode as WebhookActivationTarget["mode"],
        url,
        notifyLeaseMs: Number(row.notify_lease_ms),
        minUnackedItems: row.min_unacked_items == null ? null : Number(row.min_unacked_items),
        notificationPolicy: {
          notifyLeaseMs: Number(row.notify_lease_ms),
          minUnackedItems: row.min_unacked_items == null ? null : Number(row.min_unacked_items),
        },
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        lastSeenAt: String(row.last_seen_at),
      };
    }
    return {
      targetId: String(row.target_id),
      agentId: String(row.agent_id),
      kind: "terminal",
      status: row.status as TerminalActivationTarget["status"],
      offlineSince: row.offline_since ? String(row.offline_since) : null,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
      lastDeliveredAt: row.last_delivered_at ? String(row.last_delivered_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      mode: row.mode as TerminalActivationTarget["mode"],
      notifyLeaseMs: Number(row.notify_lease_ms),
      minUnackedItems: row.min_unacked_items == null ? null : Number(row.min_unacked_items),
      notificationPolicy: {
        notifyLeaseMs: Number(row.notify_lease_ms),
        minUnackedItems: row.min_unacked_items == null ? null : Number(row.min_unacked_items),
      },
      runtimeKind: (row.runtime_kind ? String(row.runtime_kind) : "unknown") as TerminalActivationTarget["runtimeKind"],
      runtimeSessionId: row.runtime_session_id ? String(row.runtime_session_id) : null,
      runtimePid: row.runtime_pid == null ? null : Number(row.runtime_pid),
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
      lastNotifiedFingerprint: row.last_notified_fingerprint ? String(row.last_notified_fingerprint) : null,
      deferReason: row.defer_reason ? row.defer_reason as ActivationDispatchState["deferReason"] : null,
      deferAttempts: Number(row.defer_attempts ?? 0),
      firstDeferredAt: row.first_deferred_at ? String(row.first_deferred_at) : null,
      lastDeferredAt: row.last_deferred_at ? String(row.last_deferred_at) : null,
      pendingFingerprint: row.pending_fingerprint ? String(row.pending_fingerprint) : null,
      pendingNewItemCount: Number(row.pending_new_item_count),
      pendingSummary: row.pending_summary ? String(row.pending_summary) : null,
      pendingSubscriptionIds: parseJson<string[]>(row.pending_subscription_ids_json as string),
      pendingSourceIds: parseJson<string[]>(row.pending_source_ids_json as string),
      updatedAt: String(row.updated_at),
    };
  }

  private mapTimer(row: Record<string, unknown>): AgentTimer {
    return {
      scheduleId: String(row.schedule_id),
      agentId: String(row.agent_id),
      status: String(row.status) as AgentTimer["status"],
      mode: String(row.mode) as AgentTimer["mode"],
      at: row.at ? String(row.at) : null,
      intervalMs: row.interval_ms == null ? null : Number(row.interval_ms),
      cronExpr: row.cron_expr ? String(row.cron_expr) : null,
      timezone: String(row.timezone),
      message: String(row.message),
      sender: row.sender ? String(row.sender) : null,
      nextFireAt: row.next_fire_at ? String(row.next_fire_at) : null,
      lastFiredAt: row.last_fired_at ? String(row.last_fired_at) : null,
      createdAt: String(row.created_at),
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

  private mapInboxEntry(row: Record<string, unknown>, itemIds: string[]): InboxEntry {
    const base = {
      entryId: formatEntryRef(requiredText(row, "entry_id")),
      inboxId: String(row.inbox_id),
      sequence: Number(row.sequence),
      itemId: "",
      summary: String(row.summary),
      count: Number(row.count),
      itemIds,
      sourceIds: parseJson<string[]>(row.source_ids_json as string),
      subscriptionIds: parseJson<string[]>(row.subscription_ids_json as string),
      firstItemAt: String(row.first_item_at),
      lastItemAt: String(row.last_item_at),
      deliveryHandle: row.delivery_handle_json
        ? parseJson<InboxEntry["deliveryHandle"]>(row.delivery_handle_json as string)
        : null,
      ackedAt: row.acked_at ? String(row.acked_at) : null,
      supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    };
    if (String(row.kind) === "item") {
      const item = parseJson<ActivationItem>(row.item_json as string);
      return {
        ...base,
        kind: "item",
        itemId: item.itemId,
        sourceId: item.sourceId,
        sourceNativeId: item.sourceNativeId,
        eventVariant: item.eventVariant,
        occurredAt: item.occurredAt,
        metadata: item.metadata,
        rawPayload: item.rawPayload,
        item,
      } as InboxEntry;
    }
    return {
      ...base,
      kind: "digest_snapshot",
      itemId: base.itemIds[0] ?? formatEntryRef(requiredText(row, "entry_id")),
      threadId: formatThreadRef(requiredText(row, "thread_id")),
      revision: Number(row.revision),
      groupKey: String(row.group_key),
      resourceRef: row.resource_ref ? String(row.resource_ref) : null,
      eventFamily: row.event_family ? String(row.event_family) : null,
    };
  }

  private mapDigestThread(row: Record<string, unknown>): DigestThreadRecord {
    return {
      threadId: requiredText(row, "thread_id"),
      inboxId: String(row.inbox_id),
      sourceId: String(row.source_id),
      groupKey: String(row.group_key),
      resourceRef: row.resource_ref ? String(row.resource_ref) : null,
      eventFamily: row.event_family ? String(row.event_family) : null,
      latestRevision: Number(row.latest_revision),
      latestEntryId: row.latest_entry_id == null ? null : String(row.latest_entry_id),
      status: String(row.status) as DigestThreadRecord["status"],
      summary: String(row.summary),
      firstItemAt: String(row.first_item_at),
      lastItemAt: String(row.last_item_at),
      flushAfterAt: row.flush_after_at ? String(row.flush_after_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
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
      newEntryCount: row.items_json ? parseJson<Activation["entries"]>(row.items_json as string)?.length ?? 0 : Number(row.new_item_count),
      newItemCount: Number(row.new_item_count),
      summary: String(row.summary),
      entries: row.items_json ? parseJson<Activation["entries"]>(row.items_json as string) : undefined,
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

  private resolveInboxEntryId(inboxId: string, refOrItemId: string): string {
    try {
      return parseEntryRef(refOrItemId);
    } catch {
      const row = this.getOne(
        `
        select e.entry_id
        from inbox_entries e
        join inbox_entry_items i on i.entry_id = e.entry_id
        where e.inbox_id = ?
          and i.item_id = ?
        order by e.sequence desc
        limit 1
        `,
        [inboxId, refOrItemId],
      );
      if (!row) {
        throw new Error(`unknown inbox entry: ${refOrItemId}`);
      }
      return String(row.entry_id);
    }
  }

  private insertInboxEntryRecord(input: {
    inboxId: string;
    kind: InboxEntry["kind"];
    threadId: string | null;
    revision: number | null;
    groupKey: string | null;
    resourceRef: string | null;
    eventFamily: string | null;
    itemJson: string | null;
    count: number;
    summary: string;
    firstItemAt: string;
    lastItemAt: string;
    sourceIdsJson: string;
    subscriptionIdsJson: string;
    deliveryHandleJson: string | null;
    ackedAt: string | null;
    supersededAt: string | null;
    createdAt: string;
  }): string {
    const entryId = generateCanonicalId("ent");
    this.db.run(
      `
      insert into inbox_entries (
        entry_id, inbox_id, kind, sequence, thread_id, revision, group_key, resource_ref, event_family,
        item_json, count, summary, first_item_at, last_item_at, source_ids_json,
        subscription_ids_json, delivery_handle_json, acked_at, superseded_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entryId,
        input.inboxId,
        input.kind,
        this.nextInboxEntrySequence(),
        input.threadId,
        input.revision,
        input.groupKey,
        input.resourceRef,
        input.eventFamily,
        input.itemJson,
        input.count,
        input.summary,
        input.firstItemAt,
        input.lastItemAt,
        input.sourceIdsJson,
        input.subscriptionIdsJson,
        input.deliveryHandleJson,
        input.ackedAt,
        input.supersededAt,
        input.createdAt,
      ],
    );
    return entryId;
  }

  private nextInboxEntrySequence(): number {
    const row = this.getOne("select coalesce(max(sequence), 0) + 1 as next_sequence from inbox_entries");
    return Number(row?.next_sequence ?? 1);
  }

  private listEntryItemIds(entryId: string): string[] {
    const rows = this.getAll(
      `
      select iei.item_id
      from inbox_entry_items iei
      left join inbox_items ii on ii.item_id = iei.item_id
      where iei.entry_id = ?
      order by coalesce(ii.inbox_sequence, ii.rowid, iei.rowid) asc
      `,
      [entryId],
    );
    return rows.map((row) => String(row.item_id));
  }

  private listEntryItemIdsBulk(entryIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (entryIds.length === 0) {
      return result;
    }
    const placeholders = entryIds.map(() => "?").join(", ");
    const rows = this.getAll(
      `
      select iei.entry_id, iei.item_id
      from inbox_entry_items iei
      left join inbox_items ii on ii.item_id = iei.item_id
      where iei.entry_id in (${placeholders})
      order by iei.entry_id asc, coalesce(ii.inbox_sequence, ii.rowid, iei.rowid) asc
      `,
      entryIds,
    );
    for (const row of rows) {
      const entryId = String(row.entry_id);
      const itemIds = result.get(entryId) ?? [];
      itemIds.push(String(row.item_id));
      result.set(entryId, itemIds);
    }
    return result;
  }

  private getRawItemIdsForEntryIds(entryIds: string[]): string[] {
    const itemIds = new Set<string>();
    for (const entryId of entryIds) {
      for (const itemId of this.listEntryItemIds(entryId)) {
        itemIds.add(itemId);
      }
    }
    return [...itemIds];
  }

  private mapInboxEntries(rows: Array<Record<string, unknown>>): InboxEntry[] {
    const itemIdsByEntry = this.listEntryItemIdsBulk(rows.map((row) => String(row.entry_id)));
    return rows.map((row) => this.mapInboxEntry(row, itemIdsByEntry.get(String(row.entry_id)) ?? []));
  }

  private syncInboxEntryAckState(inboxId: string, ackedAt: string): void {
    this.db.run(
      `
      update inbox_entries
      set acked_at = ?
      where inbox_id = ?
        and acked_at is null
        and not exists (
          select 1
          from inbox_entry_items e
          join inbox_items i on i.item_id = e.item_id
          where e.entry_id = inbox_entries.entry_id
            and i.acked_at is null
        )
      `,
      [ackedAt, inboxId],
    );
    this.persist();
  }

  private countAckedEntries(entryIds: string[], ackedAt: string): number {
    if (entryIds.length === 0) {
      return 0;
    }
    const placeholders = entryIds.map(() => "?").join(", ");
    const row = this.getOne(
      `select count(*) as count from inbox_entries where entry_id in (${placeholders}) and acked_at = ?`,
      [...entryIds, ackedAt],
    );
    return Number(row?.count ?? 0);
  }

  private deleteInboxItemsAndEntryArtifacts(itemIds: string[]): void {
    const placeholders = itemIds.map(() => "?").join(", ");
    this.inTransaction(() => {
      this.db.run(
        `delete from digest_thread_items where item_id in (${placeholders})`,
        itemIds,
      );
      this.db.run(
        `delete from inbox_items where item_id in (${placeholders})`,
        itemIds,
      );
      this.db.run(
        `
        delete from inbox_entries
        where entry_id in (
          select e.entry_id
          from inbox_entries e
          where not exists (
            select 1
            from inbox_entry_items ee
            where ee.entry_id = e.entry_id
              and exists (
                select 1
                from inbox_items ii
                where ii.item_id = ee.item_id
              )
          )
        )
        `,
      );
      this.db.run(
        `
        delete from inbox_entry_items
        where not exists (
          select 1
          from inbox_items ii
          where ii.item_id = inbox_entry_items.item_id
        )
        `,
      );
      this.db.run(
        `
        update digest_threads
        set latest_entry_id = (
              select e.entry_id
              from inbox_entries e
              where e.thread_id = digest_threads.thread_id
              order by coalesce(e.revision, 0) desc, e.entry_id desc
              limit 1
            ),
            latest_revision = coalesce((
              select max(coalesce(e.revision, 0))
              from inbox_entries e
              where e.thread_id = digest_threads.thread_id
            ), 0)
        `,
      );
      this.db.run(
        `
        delete from digest_threads
        where not exists (
          select 1
          from digest_thread_items dti
          where dti.thread_id = digest_threads.thread_id
        )
          and not exists (
            select 1
            from inbox_entries e
            where e.thread_id = digest_threads.thread_id
          )
        `,
      );
    });
    this.persist();
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

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value == null) {
    throw new Error(`missing required column: ${key}`);
  }
  return String(value);
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function summarizeBackfilledItemEntry(item: InboxItem): string {
  return `${item.eventVariant} from ${item.sourceId}`;
}
