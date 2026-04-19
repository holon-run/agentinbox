import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { AdapterRegistry } from "../src/adapters";
import { EventBusBackend, SqliteEventBusBackend } from "../src/backend";
import { Activation, ActivationTarget, AppendSourceEventInput, Subscription, TerminalActivationTarget } from "../src/model";
import { ActivationDispatcher, AgentInboxService } from "../src/service";
import { ActivationGate } from "../src/runtime_gate";
import { UxcRemoteSourceClient } from "../src/sources/remote";
import { AgentInboxStore } from "../src/store";
import { assignedAgentIdFromContext, TerminalDispatcher, TerminalProbeStatus } from "../src/terminal";
import { nowIso } from "../src/util";

class RecordingActivationDispatcher extends ActivationDispatcher {
  public readonly calls: Array<{ targetUrl: string; activation: Activation }> = [];

  override async dispatch(targetUrl: string, activation: Activation): Promise<void> {
    this.calls.push({ targetUrl, activation });
  }
}

class RecordingTerminalDispatcher extends TerminalDispatcher {
  public readonly calls: Array<{ target: TerminalActivationTarget; prompt: string }> = [];
  public probeResult = true;
  public probeStatusResult: TerminalProbeStatus = "available";

  override async dispatch(target: TerminalActivationTarget, prompt: string): Promise<void> {
    this.calls.push({ target, prompt });
  }

  override async probe(_target: TerminalActivationTarget): Promise<boolean> {
    return this.probeResult;
  }

  override async probeStatus(_target: TerminalActivationTarget): Promise<TerminalProbeStatus> {
    return this.probeStatusResult;
  }
}

class FailingTerminalDispatcher extends RecordingTerminalDispatcher {
  override async dispatch(_target: TerminalActivationTarget, _prompt: string): Promise<void> {
    throw new Error("terminal unavailable");
  }
}

class FixedActivationGate implements ActivationGate {
  constructor(
    private readonly outcome: "inject" | "defer" | "offline",
    private readonly reason = "test",
  ) {}

  async evaluate(_target: TerminalActivationTarget): Promise<{ outcome: "inject" | "defer" | "offline"; reason: string }> {
    return {
      outcome: this.outcome,
      reason: this.reason,
    };
  }
}

class MutableActivationGate implements ActivationGate {
  constructor(
    private outcome: "inject" | "defer" | "offline",
    private reason = "test",
  ) {}

  set(outcome: "inject" | "defer" | "offline", reason = this.reason): void {
    this.outcome = outcome;
    this.reason = reason;
  }

  async evaluate(_target: TerminalActivationTarget): Promise<{ outcome: "inject" | "defer" | "offline"; reason: string }> {
    return {
      outcome: this.outcome,
      reason: this.reason,
    };
  }
}

class BlockingActivationGate implements ActivationGate {
  private startedResolver: (() => void) | null = null;
  private releaseResolver: ((result: { outcome: "inject" | "defer" | "offline"; reason: string }) => void) | null = null;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolver = resolve;
  });
  private readonly release = new Promise<{ outcome: "inject" | "defer" | "offline"; reason: string }>((resolve) => {
    this.releaseResolver = resolve;
  });

  async waitUntilStarted(): Promise<void> {
    await this.started;
  }

  unblock(outcome: "inject" | "defer" | "offline", reason = "test"): void {
    this.releaseResolver?.({ outcome, reason });
    this.releaseResolver = null;
  }

  async evaluate(_target: TerminalActivationTarget): Promise<{ outcome: "inject" | "defer" | "offline"; reason: string }> {
    this.startedResolver?.();
    this.startedResolver = null;
    return this.release;
  }
}

class FakeRemoteSourceClient implements UxcRemoteSourceClient {
  async sourceEnsure(args: { namespace: string; sourceKey: string; spec: unknown }): Promise<{
    namespace: string;
    source_key: string;
    run_id: string;
    stream_id: string;
    status: string;
    reused: boolean;
    replaced_previous: boolean;
  }> {
    void args.spec;
    return {
      namespace: args.namespace,
      source_key: args.sourceKey,
      run_id: `run:${args.sourceKey}`,
      stream_id: `stream:${args.sourceKey}`,
      status: "running",
      reused: true,
      replaced_previous: false,
    };
  }

  async sourceStop(_namespace: string, _sourceKey: string): Promise<void> {
    return;
  }

  async sourceDelete(_namespace: string, _sourceKey: string): Promise<void> {
    return;
  }

  async streamRead(_args: { streamId: string; afterOffset?: number; limit?: number }): Promise<{
    stream_id: string;
    events: Array<{ stream_id: string; offset: number; ingested_at_unix: number; raw_payload: unknown }>;
    next_after_offset: number;
    has_more: boolean;
  }> {
    return {
      stream_id: "stream:noop",
      events: [],
      next_after_offset: 0,
      has_more: false,
    };
  }
}

class FailOnNthEnsureConsumerBackend extends SqliteEventBusBackend {
  private ensureConsumerCalls = 0;

  constructor(store: AgentInboxStore, private readonly failAtCall: number) {
    super(store);
  }

  override async ensureConsumer(input: Parameters<SqliteEventBusBackend["ensureConsumer"]>[0]) {
    this.ensureConsumerCalls += 1;
    if (this.ensureConsumerCalls === this.failAtCall) {
      throw new Error("ensureConsumer failed for test");
    }
    return super.ensureConsumer(input);
  }
}

async function makeService(options?: {
  dispatcher?: ActivationDispatcher;
  terminalDispatcher?: TerminalDispatcher;
  activationGate?: ActivationGate;
  activationWindowMs?: number;
  activationMaxItems?: number;
  backend?: EventBusBackend;
}): Promise<{ store: AgentInboxStore; service: AgentInboxService; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input), {
    homeDir: dir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(
    store,
    adapters,
    options?.dispatcher,
    options?.backend ?? new SqliteEventBusBackend(store),
    {
      windowMs: options?.activationWindowMs,
      maxItems: options?.activationMaxItems,
    },
    options?.terminalDispatcher ?? new TerminalDispatcher(async () => ({
      stdout: "",
      stderr: "",
    })),
    options?.activationGate,
  );
  return { store, service, dir };
}

async function makeServiceFromDbPath(
  dbPath: string,
  dir: string,
  options?: {
    dispatcher?: ActivationDispatcher;
    terminalDispatcher?: TerminalDispatcher;
    activationGate?: ActivationGate;
    activationWindowMs?: number;
    activationMaxItems?: number;
    backend?: EventBusBackend;
  },
): Promise<{ store: AgentInboxStore; service: AgentInboxService }> {
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input), {
    homeDir: dir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(
    store,
    adapters,
    options?.dispatcher,
    options?.backend ?? new SqliteEventBusBackend(store),
    {
      windowMs: options?.activationWindowMs,
      maxItems: options?.activationMaxItems,
    },
    options?.terminalDispatcher ?? new TerminalDispatcher(async () => ({
      stdout: "",
      stderr: "",
    })),
    options?.activationGate,
  );
  return { store, service };
}

async function registerTmuxAgent(service: AgentInboxService, suffix: string): Promise<{ agentId: string; targetId: string }> {
  const registered = service.registerAgent({
    backend: "tmux",
    runtimeKind: "codex",
    runtimeSessionId: `thread-${suffix}`,
    tmuxPaneId: `%${suffix}`,
    notifyLeaseMs: 50,
  });
  return {
    agentId: registered.agent.agentId,
    targetId: registered.terminalTarget.targetId,
  };
}

async function createLegacyDb(dbPath: string): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
  });
  const db = new SQL.Database();
  db.exec(`
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
      status text not null,
      offline_since text,
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
      filter_json text not null,
      lifecycle_mode text not null,
      expires_at text,
      start_policy text not null,
      start_offset integer,
      start_time text,
      created_at text not null
    );

    create table if not exists activation_targets (
      target_id text primary key,
      agent_id text not null,
      kind text not null,
      status text not null,
      offline_since text,
      consecutive_failures integer not null,
      last_delivered_at text,
      last_error text,
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
  `);
  db.exec("pragma user_version = 12;");
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function createV1BaselineDbWithSourceScopedLifecycleRetirement(dbPath: string): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
  });
  const db = new SQL.Database();
  const baselineSql = fs.readFileSync(path.resolve(__dirname, "../drizzle/migrations/0000_v1_initial.sql"), "utf8");
  db.exec(`
    create table if not exists __drizzle_migrations (
      id integer primary key autoincrement,
      tag text not null unique,
      applied_at text not null
    );
  `);
  db.exec(baselineSql);
  db.exec(`
    insert into __drizzle_migrations (tag, applied_at) values ('0000_v1_initial', '2026-04-19T00:00:00.000Z');
    insert into source_hosts (host_id, host_type, host_key, config_ref, config_json, status, created_at, updated_at)
    values ('hst_legacy_github', 'github', 'uxcAuth:default', null, '{}', 'active', '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z');
    insert into sources (
      source_id, host_id, stream_kind, stream_key, source_type, source_key, config_ref, config_json, status, checkpoint, created_at, updated_at
    ) values (
      'src_legacy_github', 'hst_legacy_github', 'repo_events', 'holon-run/agentinbox', 'github_repo', 'holon-run/agentinbox', null, '{}', 'active', null,
      '2026-04-19T00:00:00.000Z', '2026-04-19T00:00:00.000Z'
    );
    insert into subscription_lifecycle_retirements (
      subscription_id, source_id, tracked_resource_ref, retire_at, terminal_state, terminal_result, terminal_occurred_at, created_at, updated_at
    ) values (
      'sub_legacy_retirement', 'src_legacy_github', 'repo:holon-run/agentinbox:pr:72', '2026-04-19T01:00:00.000Z', 'closed', 'merged',
      '2026-04-19T00:30:00.000Z', '2026-04-19T00:30:00.000Z', '2026-04-19T00:30:00.000Z'
    );
  `);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function readMigrationState(dbPath: string): Promise<{
  appliedTags: string[];
  hasNewIndex: boolean;
  retirementColumns: string[];
  hasTrackedResourceIndex: boolean;
}> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
  });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const migrationResult = db.exec("select tag from __drizzle_migrations order by id asc;") as Array<{ values: unknown[][] }>;
  const appliedTags = (migrationResult[0]?.values ?? []).map((row) => String(row[0]));
  const indexResult = db.exec("pragma index_list('inbox_items');") as Array<{ values: unknown[][] }>;
  const hasNewIndex = indexResult.some((set) =>
    set.values.some((row) => String(row[1]) === "idx_inbox_items_source_occurred_at"),
  );
  const subscriptionIndexResult = db.exec("pragma index_list('subscriptions');") as Array<{ values: unknown[][] }>;
  const hasTrackedResourceIndex = subscriptionIndexResult.some((set) =>
    set.values.some((row) => String(row[1]) === "idx_subscriptions_tracked_resource_source"),
  );
  const retirementColumnsResult = db.exec("pragma table_info('subscription_lifecycle_retirements');") as Array<{ values: unknown[][] }>;
  const retirementColumns = (retirementColumnsResult[0]?.values ?? []).map((row) => String(row[1]));
  db.close();
  return { appliedTags, hasNewIndex, retirementColumns, hasTrackedResourceIndex };
}

test("store migrates a new database using drizzle SQL migrations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-new-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
    ]);
    assert.equal(state.hasNewIndex, true);
    assert.deepEqual(state.retirementColumns.includes("host_id"), true);
    assert.equal(state.hasTrackedResourceIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".pre-v1."));
    assert.equal(backups.length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store reopens an existing v1 database without archiving it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-reopen-v1-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const first = await AgentInboxStore.open(dbPath);
  first.close();

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  const reopened = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
    ]);
    assert.equal(warnings.length, 0);
    assert.equal(state.hasTrackedResourceIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".pre-v1."));
    assert.equal(backups.length, 0);
  } finally {
    console.warn = originalWarn;
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store archives a pre-v1 database and starts fresh with the v1 baseline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-legacy-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createLegacyDb(dbPath);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
    ]);
    assert.equal(state.hasNewIndex, true);
    assert.equal(state.hasTrackedResourceIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".pre-v1."));
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, /^agentinbox\.sqlite\.pre-v1\..+\.bak(?:\.\d+)?$/);
    assert.match(warnings[0] ?? "", /archived pre-v1 local database/);
    assert.match(warnings[0] ?? "", /no data imported/);
  } finally {
    console.warn = originalWarn;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store upgrades source-scoped lifecycle retirements to host-scoped retirements for existing v1 databases", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-lifecycle-host-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createV1BaselineDbWithSourceScopedLifecycleRetirement(dbPath);
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.deepEqual(state.appliedTags, [
      "0000_v1_initial",
      "0002_host_scoped_lifecycle_retirements",
      "0003_subscription_tracked_resource_indexes",
    ]);
    assert.deepEqual(state.retirementColumns.includes("host_id"), true);
    assert.deepEqual(state.retirementColumns.includes("source_id"), false);
    assert.equal(state.hasTrackedResourceIndex, true);
    const retirement = store.getSubscriptionLifecycleRetirement("sub_legacy_retirement");
    assert.equal(retirement?.hostId, "hst_legacy_github");
    assert.equal(retirement?.trackedResourceRef, "repo:holon-run/agentinbox:pr:72");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store archives repeated pre-v1 databases without clobbering earlier backups", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-legacy-repeat-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createLegacyDb(dbPath);
  try {
    const first = await AgentInboxStore.open(dbPath);
    first.close();

    await createLegacyDb(dbPath);
    const second = await AgentInboxStore.open(dbPath);
    second.close();

    const backups = fs.readdirSync(dir)
      .filter((name) => name.includes(".pre-v1."))
      .sort();
    assert.equal(backups.length, 2);
    assert.notEqual(backups[0], backups[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent register creates a stable agent, inbox, and terminal activation target", async () => {
  const { store, service, dir } = await makeService();
  try {
    const first = service.registerAgent({
      backend: "iterm2",
      runtimeKind: "codex",
      runtimeSessionId: "019d57fd-6524-7e20-a850-a89e81957100",
      itermSessionId: "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
      termProgram: "iTerm.app",
      tty: "/dev/ttys049",
    });
    const second = service.registerAgent({
      backend: "iterm2",
      runtimeKind: "codex",
      runtimeSessionId: "019d57fd-6524-7e20-a850-a89e81957100",
      itermSessionId: "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
      termProgram: "iTerm.app",
      tty: "/dev/ttys049",
    });

    assert.equal(first.agent.agentId, assignedAgentIdFromContext({
      runtimeKind: "codex",
      runtimeSessionId: "019d57fd-6524-7e20-a850-a89e81957100",
      backend: "iterm2",
      itermSessionId: "4B4CB6B2-A73B-4420-94A7-BD2CA216A285",
      tty: "/dev/ttys049",
    }));
    assert.equal(second.agent.agentId, first.agent.agentId);
    assert.equal(second.terminalTarget.targetId, first.terminalTarget.targetId);
    assert.equal(store.listAgents().length, 1);
    assert.equal(store.listActivationTargetsForAgent(first.agent.agentId).length, 1);
    const details = service.getInboxDetailsByAgent(first.agent.agentId) as { inbox: { ownerAgentId: string } };
    assert.equal(details.inbox.ownerAgentId, first.agent.agentId);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent register accepts caller-supplied agent ids and upserts the same logical agent", async () => {
  const { store, service, dir } = await makeService();
  try {
    const first = service.registerAgent({
      agentId: "agent-alpha",
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-agent-alpha",
      tmuxPaneId: "%501",
    });
    const second = service.registerAgent({
      agentId: "agent-alpha",
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-agent-alpha",
      tmuxPaneId: "%501",
    });

    assert.equal(first.agent.agentId, "agent-alpha");
    assert.equal(second.agent.agentId, "agent-alpha");
    assert.equal(second.terminalTarget.targetId, first.terminalTarget.targetId);
    assert.equal(store.listAgents().length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent register rejects caller-supplied agent id conflicts without force rebind", async () => {
  const { store, service, dir } = await makeService();
  try {
    service.registerAgent({
      agentId: "agent-alpha",
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-agent-alpha",
      tmuxPaneId: "%502",
    });

    await assert.rejects(async () => {
      service.registerAgent({
        agentId: "agent-alpha",
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-agent-alpha-rebound",
        tmuxPaneId: "%503",
      });
    }, /agent register conflict/);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent register force rebind moves the logical agent to the current terminal target", async () => {
  const { store, service, dir } = await makeService();
  try {
    const first = service.registerAgent({
      agentId: "agent-alpha",
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-agent-alpha",
      tmuxPaneId: "%504",
    });

    const rebound = service.registerAgent({
      agentId: "agent-alpha",
      forceRebind: true,
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-agent-alpha-rebound",
      tmuxPaneId: "%505",
    });

    assert.equal(rebound.agent.agentId, "agent-alpha");
    assert.equal(rebound.agent.runtimeSessionId, "thread-agent-alpha-rebound");
    assert.notEqual(rebound.terminalTarget.targetId, first.terminalTarget.targetId);
    const targets = service.listActivationTargets("agent-alpha");
    assert.equal(targets.length, 1);
    assert.equal(targets[0].kind, "terminal");
    assert.equal(targets[0].kind === "terminal" ? targets[0].tmuxPaneId : null, "%505");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shared source can route one stream event to multiple agent inboxes", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "1");
    const beta = await registerTmuxAgent(service, "2");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "demo",
      config: {},
    });
    const subscriptionA = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { channel: "engineering" } },
    });
    const subscriptionB = await service.registerSubscription({
      agentId: beta.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { channel: "engineering" } },
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: { text: "hello" },
    });

    const pollA = await service.pollSubscription(subscriptionA.subscriptionId);
    const pollB = await service.pollSubscription(subscriptionB.subscriptionId);

    assert.equal(pollA.inboxItemsCreated, 1);
    assert.equal(pollB.inboxItemsCreated, 1);
    assert.equal(service.listInboxItems(alpha.agentId).length, 1);
    assert.equal(service.listInboxItems(beta.agentId).length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local_event source can act as a programmable event bus source", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "3");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "project-alpha",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      filter: { metadata: { channel: "engineering" } },
      startPolicy: "earliest",
    });

    const appendResult = await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "local-evt-1",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: { text: "hello from local event source" },
    });
    assert.equal(appendResult.appended, 1);

    const pollResult = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(alpha.agentId);
    assert.equal(pollResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceNativeId, "local-evt-1");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote_source registration succeeds", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "demo.mjs"),
      `export default {
  id: "demo.profile",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: String(raw.id), eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "remote-demo",
      config: {
        modulePath: "demo.mjs",
        moduleConfig: {},
      },
    });
    assert.equal(source.sourceType, "remote_source");

    const details = await service.getSourceDetails(source.sourceId) as {
      resolvedIdentity: {
        hostType: string;
        sourceKind: string;
        implementationId: string;
      };
      schema: {
        sourceId: string;
        hostType: string;
        sourceKind: string;
        implementationId: string;
        followSchema?: unknown;
        subscriptionSchema: {
          supportsTrackedResourceRef: boolean;
          supportsLifecycleSignals: boolean;
          shortcuts: unknown[];
        };
      };
    };
    assert.deepEqual(details.resolvedIdentity, {
      hostType: "remote_source",
      sourceKind: "remote:demo.profile",
      implementationId: "demo.profile",
    });
    assert.equal(details.schema.sourceId, source.sourceId);
    assert.equal(details.schema.hostType, "remote_source");
    assert.equal(details.schema.sourceKind, "remote:demo.profile");
    assert.equal(details.schema.implementationId, "demo.profile");
    assert.deepEqual(details.schema.subscriptionSchema, {
      supportsTrackedResourceRef: false,
      supportsLifecycleSignals: false,
      shortcuts: [],
    });
    assert.equal("followSchema" in details.schema, false);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builtin remote-backed source details expose resolved remote identity", async () => {
  const { store, service, dir } = await makeService();
  try {
    const source = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });

    const details = await service.getSourceDetails(source.sourceId) as {
      resolvedIdentity: {
        hostType: string;
        sourceKind: string;
        implementationId: string;
      };
      schema: {
        hostType: string;
        sourceKind: string;
        implementationId: string;
        aliases?: string[];
        followSchema?: unknown;
        subscriptionSchema: {
          supportsTrackedResourceRef: boolean;
          supportsLifecycleSignals: boolean;
          shortcuts: unknown[];
        };
      };
    };
    assert.deepEqual(details.resolvedIdentity, {
      hostType: "remote_source",
      sourceKind: "github_repo",
      implementationId: "builtin.github_repo",
    });
    assert.equal(details.schema.hostType, "remote_source");
    assert.equal(details.schema.sourceKind, "github_repo");
    assert.equal(details.schema.implementationId, "builtin.github_repo");
    assert.deepEqual(details.schema.aliases, ["github_repo"]);
    assert.deepEqual(details.schema.subscriptionSchema, {
      supportsTrackedResourceRef: true,
      supportsLifecycleSignals: true,
      shortcuts: [{
        name: "pr",
        description: "Follow one pull request and auto-retire when it closes.",
        argsSchema: [
          { name: "number", type: "number", required: true, description: "Pull request number." },
          {
            name: "withCi",
            type: "boolean",
            required: false,
            description: "Also create a sibling ci_runs subscription under the same host and stream key.",
          },
        ],
      }],
    });
    assert.deepEqual(details.schema.followSchema, {
      templates: [{
        templateId: "github.repo",
        providerOrKind: "github",
        label: "GitHub Repository",
        description: "Follow a repository event stream.",
        argsSchema: [
          { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
          { name: "repo", type: "string", required: true, description: "GitHub repository name." },
        ],
      }, {
        templateId: "github.pr",
        providerOrKind: "github",
        label: "GitHub Pull Request",
        description: "Follow one pull request and optionally its CI.",
        argsSchema: [
          { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
          { name: "repo", type: "string", required: true, description: "GitHub repository name." },
          { name: "number", type: "number", required: true, description: "Pull request number." },
          {
            name: "withCi",
            type: "boolean",
            required: false,
            description: "Also follow the repository CI stream for that pull request.",
          },
        ],
      }, {
        templateId: "github.issue",
        providerOrKind: "github",
        label: "GitHub Issue",
        description: "Follow one issue without automatic terminal cleanup.",
        argsSchema: [
          { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
          { name: "repo", type: "string", required: true, description: "GitHub repository name." },
          { name: "number", type: "number", required: true, description: "Issue number." },
        ],
      }],
    });
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stream schema preview resolves a user-defined remote module without persisting a source", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "preview.mjs"),
      `export default {
  id: "demo.preview",
  validateConfig(source) {
    if (!source.config.token) throw new Error("preview token required");
  },
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() { return null; },
  describeCapabilities() {
    return {
      sourceKind: "remote:demo.preview",
      configSchema: [{ name: "token", type: "string", required: true, description: "Preview token." }],
      metadataFields: [{ name: "ticketId", type: "string", description: "Ticket id." }],
      eventVariantExamples: ["ticket.updated"],
      payloadExamples: [{ id: "T-1" }]
    };
  }
};`,
      "utf8",
    );

    const preview = await service.previewSourceSchema({
      sourceRef: "remote:demo.preview",
      config: {
        modulePath: "preview.mjs",
        moduleConfig: { token: "demo-token" },
      },
    });
    assert.equal(preview.sourceType, "remote_source");
    assert.equal(preview.hostType, "remote_source");
    assert.equal(preview.sourceKind, "remote:demo.preview");
    assert.equal(preview.implementationId, "demo.preview");
    assert.deepEqual(preview.configFields, [
      { name: "token", type: "string", required: true, description: "Preview token." },
    ]);
    assert.deepEqual(preview.metadataFields, [
      { name: "ticketId", type: "string", description: "Ticket id." },
    ]);
    assert.equal(store.listSources().length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stream schema preview supports builtin remote-backed aliases without persisting a source", async () => {
  const { store, service, dir } = await makeService();
  try {
    const preview = await service.previewSourceSchema({
      sourceRef: "github_repo",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    assert.equal(preview.sourceType, "github_repo");
    assert.equal(preview.hostType, "remote_source");
    assert.equal(preview.sourceKind, "github_repo");
    assert.equal(preview.implementationId, "builtin.github_repo");
    assert.ok(preview.subscriptionSchema);
    assert.deepEqual(preview.subscriptionSchema?.shortcuts, [{
      name: "pr",
      description: "Follow one pull request and auto-retire when it closes.",
      argsSchema: [
        { name: "number", type: "number", required: true, description: "Pull request number." },
        {
          name: "withCi",
          type: "boolean",
          required: false,
          description: "Also create a sibling ci_runs subscription under the same host and stream key.",
        },
      ],
    }]);
    assert.deepEqual(preview.followSchema, {
      templates: [{
        templateId: "github.repo",
        providerOrKind: "github",
        label: "GitHub Repository",
        description: "Follow a repository event stream.",
        argsSchema: [
          { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
          { name: "repo", type: "string", required: true, description: "GitHub repository name." },
        ],
      }, {
        templateId: "github.pr",
        providerOrKind: "github",
        label: "GitHub Pull Request",
        description: "Follow one pull request and optionally its CI.",
        argsSchema: [
          { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
          { name: "repo", type: "string", required: true, description: "GitHub repository name." },
          { name: "number", type: "number", required: true, description: "Pull request number." },
          {
            name: "withCi",
            type: "boolean",
            required: false,
            description: "Also follow the repository CI stream for that pull request.",
          },
        ],
      }, {
        templateId: "github.issue",
        providerOrKind: "github",
        label: "GitHub Issue",
        description: "Follow one issue without automatic terminal cleanup.",
        argsSchema: [
          { name: "owner", type: "string", required: true, description: "GitHub repository owner." },
          { name: "repo", type: "string", required: true, description: "GitHub repository name." },
          { name: "number", type: "number", required: true, description: "Issue number." },
        ],
      }],
    });
    assert.equal(store.listSources().length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote_source capability hooks override resolved schema fields and advertise shortcut/lifecycle support", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "capabilities.mjs"),
      `export default {
  id: "demo.capabilities",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    if (!raw.id) return null;
    return { sourceNativeId: String(raw.id), eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  },
  describeCapabilities() {
    return {
      sourceKind: "remote:demo.capabilities.custom",
      aliases: ["demo_capabilities"],
      configSchema: [{ name: "tenant", type: "string", required: true, description: "Tenant identifier." }],
      metadataFields: [{ name: "tenant", type: "string", description: "Normalized tenant id." }],
      eventVariantExamples: ["demo.custom.created"],
      payloadExamples: [{ id: "evt-1", tenant: "team-a" }]
    };
  },
  listSubscriptionShortcuts() {
    return [{
      name: "pr",
      description: "Follow one pull request",
      argsSchema: [{ name: "number", type: "number", required: true, description: "Pull request number." }]
    }];
  },
  listFollowTemplates() {
    return [{
      templateId: "demo.ticket",
      providerOrKind: "demo",
      label: "Demo Ticket",
      description: "Follow one ticket",
      argsSchema: [{ name: "id", type: "string", required: true, description: "Ticket id." }]
    }];
  },
  deriveTrackedResource() {
    return { ref: "resource:demo" };
  },
  projectLifecycleSignal() {
    return { ref: "resource:demo", terminal: true, state: "closed", result: "done" };
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "capabilities-demo",
      config: {
        modulePath: "capabilities.mjs",
        moduleConfig: {},
      },
    });

    const schema = await service.getResolvedSourceSchema(source.sourceId);
    assert.equal(schema.sourceKind, "remote:demo.capabilities.custom");
    assert.equal(schema.implementationId, "demo.capabilities");
    assert.deepEqual(schema.aliases, ["demo_capabilities"]);
    assert.deepEqual(schema.configFields, [
      { name: "tenant", type: "string", required: true, description: "Tenant identifier." },
    ]);
    assert.deepEqual(schema.metadataFields, [
      { name: "tenant", type: "string", description: "Normalized tenant id." },
    ]);
    assert.deepEqual(schema.eventVariantExamples, ["demo.custom.created"]);
    assert.deepEqual(schema.payloadExamples, [{ id: "evt-1", tenant: "team-a" }]);
    assert.deepEqual(schema.subscriptionSchema, {
      supportsTrackedResourceRef: true,
      supportsLifecycleSignals: true,
      shortcuts: [{
        name: "pr",
        description: "Follow one pull request",
        argsSchema: [{ name: "number", type: "number", required: true, description: "Pull request number." }],
      }],
    });
    assert.deepEqual(schema.followSchema, {
      templates: [{
        templateId: "demo.ticket",
        providerOrKind: "demo",
        label: "Demo Ticket",
        description: "Follow one ticket",
        argsSchema: [{ name: "id", type: "string", required: true, description: "Ticket id." }],
      }],
    });
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local_event resolved schema does not expose remote-only subscription capability metadata", async () => {
  const { store, service, dir } = await makeService();
  try {
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-schema-demo",
      config: {},
    });

    const schema = await service.getResolvedSourceSchema(source.sourceId) as {
      hostType: string;
      sourceKind: string;
      implementationId: string;
      subscriptionSchema?: unknown;
    };
    assert.equal(schema.hostType, "local_event");
    assert.equal(schema.sourceKind, "local_event");
    assert.equal(schema.implementationId, "builtin.local_event");
    assert.equal("subscriptionSchema" in schema, false);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source details keep a wrapped fallback schema when non-identity capability hooks throw", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "broken-shortcuts.mjs"),
      `export default {
  id: "demo.broken-shortcuts",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      operation_id: "get:/events",
      args: {},
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() {
    return null;
  },
  listSubscriptionShortcuts() {
    throw new Error("broken listSubscriptionShortcuts");
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "broken-shortcuts-demo",
      config: {
        modulePath: "broken-shortcuts.mjs",
        moduleConfig: {},
      },
    });

    const details = await service.getSourceDetails(source.sourceId) as {
      resolvedIdentity: {
        hostType: string;
        sourceKind: string;
        implementationId: string;
      };
      resolutionError: string;
      schema: {
        sourceType: string;
        hostType: string;
        sourceKind: string;
        implementationId: string;
      };
    };
    assert.deepEqual(details.resolvedIdentity, {
      hostType: "remote_source",
      sourceKind: "remote:demo.broken-shortcuts",
      implementationId: "demo.broken-shortcuts",
    });
    assert.match(details.resolutionError, /broken listSubscriptionShortcuts/);
    assert.equal(details.schema.sourceType, "remote_source");
    assert.equal(details.schema.hostType, "remote_source");
    assert.equal(details.schema.sourceKind, "remote:demo.broken-shortcuts");
    assert.equal(details.schema.implementationId, "demo.broken-shortcuts");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription add can expand a remote module shortcut into standard subscription fields", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "shortcut-expand.mjs"),
      `export default {
  id: "demo.shortcut.expand",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() {
    return null;
  },
  listSubscriptionShortcuts() {
    return [{
      name: "ticket",
      description: "Follow one ticket",
      argsSchema: [{ name: "id", type: "string", required: true, description: "Ticket id." }]
    }];
  },
  expandSubscriptionShortcut(input) {
    if (input.name !== "ticket") return null;
    return {
      filter: { metadata: { ticketId: input.args.id } },
      trackedResourceRef: "ticket:" + input.args.id,
      cleanupPolicy: { mode: "manual" }
    };
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "shortcut-expand-demo",
      config: {
        modulePath: "shortcut-expand.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "shortcut-expand-thread",
      tmuxPaneId: "%944",
    });

    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      shortcut: {
        name: "ticket",
        args: { id: "A-42" },
      },
      startPolicy: "earliest",
    });

    assert.deepEqual(subscription.filter, { metadata: { ticketId: "A-42" } });
    assert.equal(subscription.trackedResourceRef, "ticket:A-42");
    assert.deepEqual(subscription.cleanupPolicy, { mode: "manual" });
    assert.equal(subscription.startPolicy, "earliest");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github pr shortcut with withCi creates repo and sibling ci subscriptions", async () => {
  const { store, service, dir } = await makeService();
  try {
    const repoSource = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const ciSource = await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-pr-with-ci-thread",
      tmuxPaneId: "%945",
    });

    const subscriptions = await service.registerSubscriptions({
      agentId: agent.agent.agentId,
      sourceId: repoSource.sourceId,
      shortcut: {
        name: "pr",
        args: { number: 93, withCi: true },
      },
    });

    assert.equal(subscriptions.length, 2);
    assert.deepEqual(
      subscriptions.map((subscription) => subscription.sourceId).sort(),
      [ciSource.sourceId, repoSource.sourceId].sort(),
    );
    assert.deepEqual(
      subscriptions.map((subscription) => subscription.trackedResourceRef),
      ["repo:holon-run/agentinbox:pr:93", "repo:holon-run/agentinbox:pr:93"],
    );
    assert.deepEqual(
      subscriptions.map((subscription) => subscription.filter),
      [
        { metadata: { number: 93, isPullRequest: true } },
        { metadata: { pullRequestNumbers: [93] } },
      ],
    );
    assert.deepEqual(subscriptions.map((subscription) => subscription.cleanupPolicy), [
      { mode: "on_terminal" },
      { mode: "on_terminal" },
    ]);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("follow github pr ensures sources and dedupes subscriptions", async () => {
  const { store, service, dir } = await makeService();
  try {
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-follow-pr-thread",
      tmuxPaneId: "%945-follow",
    });

    const first = await service.follow({
      agentId: agent.agent.agentId,
      providerOrKind: "github",
      template: "pr",
      templateArgs: {
        owner: "holon-run",
        repo: "agentinbox",
        number: 93,
        withCi: true,
      },
    });

    assert.equal(first.templateId, "github.pr");
    assert.deepEqual(first.sources.map((source) => source.created), [true, true]);
    assert.deepEqual(first.subscriptions.map((subscription) => subscription.created), [true, true]);
    assert.equal(store.listSources().length, 2);
    assert.equal(store.listSubscriptions().length, 2);

    const second = await service.follow({
      agentId: agent.agent.agentId,
      providerOrKind: "github",
      template: "pr",
      templateArgs: {
        owner: "holon-run",
        repo: "agentinbox",
        number: 93,
        withCi: true,
      },
    });

    assert.deepEqual(second.sources.map((source) => source.created), [false, false]);
    assert.deepEqual(second.subscriptions.map((subscription) => subscription.created), [false, false]);
    assert.equal(store.listSources().length, 2);
    assert.equal(store.listSubscriptions().length, 2);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("follow github repo creates a repository subscription", async () => {
  const { store, service, dir } = await makeService();
  try {
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-follow-repo-thread",
      tmuxPaneId: "%946-follow",
    });

    const first = await service.follow({
      agentId: agent.agent.agentId,
      providerOrKind: "github",
      template: "repo",
      templateArgs: {
        owner: "holon-run",
        repo: "agentinbox",
      },
    });

    assert.equal(first.templateId, "github.repo");
    assert.deepEqual(first.sources.map((source) => source.created), [true]);
    assert.deepEqual(first.subscriptions.map((subscription) => subscription.created), [true]);
    assert.equal(store.listSources().length, 1);
    assert.equal(store.listSubscriptions().length, 1);

    const second = await service.follow({
      agentId: agent.agent.agentId,
      providerOrKind: "github",
      template: "repo",
      templateArgs: {
        owner: "holon-run",
        repo: "agentinbox",
      },
    });

    assert.deepEqual(second.sources.map((source) => source.created), [false]);
    assert.deepEqual(second.subscriptions.map((subscription) => subscription.created), [false]);
    assert.equal(store.listSources().length, 1);
    assert.equal(store.listSubscriptions().length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("follow resolves providerOrKind through remote module templates without core provider mapping", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "follow-provider.mjs"),
      `export default {
  id: "demo.follow-provider",
  validateConfig(source) {
    if (!source.config.tenant) throw new Error("tenant required");
  },
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() { return null; },
  listFollowTemplates() {
    return [{
      templateId: "demo.ticket",
      providerOrKind: "demo",
      label: "Demo Ticket",
      description: "Follow one ticket",
      argsSchema: [{ name: "id", type: "string", required: true, description: "Ticket id." }]
    }];
  },
  expandFollowTemplate(input) {
    if (input.template !== "ticket") return null;
    return {
      templateId: "demo.ticket",
      sources: [{
        logicalName: "events",
        sourceType: "local_event",
        sourceKey: "demo-follow-events",
        config: {}
      }],
      subscriptions: [{
        sourceLogicalName: "events",
        filter: { metadata: { ticketId: input.args.id } },
        trackedResourceRef: "ticket:" + input.args.id,
        cleanupPolicy: { mode: "manual" }
      }]
    };
  }
};`,
      "utf8",
    );

    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "demo-follow-provider-thread",
      tmuxPaneId: "%947-follow",
    });

    const followed = await service.follow({
      agentId: agent.agent.agentId,
      providerOrKind: "demo",
      template: "ticket",
      templateArgs: {
        id: "A-9",
      },
      config: {
        modulePath: "follow-provider.mjs",
        moduleConfig: {
          tenant: "team-a",
        },
      },
    });

    assert.equal(followed.templateId, "demo.ticket");
    assert.deepEqual(followed.sources.map((source) => source.created), [true]);
    assert.deepEqual(followed.subscriptions.map((subscription) => subscription.created), [true]);
    assert.equal(store.listSources().length, 1);
    assert.equal(store.listSubscriptions().length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSubscription rejects invalid start policy requirements", async () => {
  const { store, service, dir } = await makeService();
  try {
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "start-policy-validation",
      config: {},
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "start-policy-validation-thread",
      tmuxPaneId: "%945-start-policy",
    });

    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agent.agentId,
        sourceId: source.sourceId,
        startPolicy: "at_time",
      } as never),
      /subscriptions requires valid ISO8601 startTime when startPolicy=at_time/,
    );

    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agent.agentId,
        sourceId: source.sourceId,
        startPolicy: "at_offset",
      } as never),
      /subscriptions requires positive integer startOffset when startPolicy=at_offset/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github pr shortcut with withCi fails clearly when sibling ci stream is missing", async () => {
  const { store, service, dir } = await makeService();
  try {
    const repoSource = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-pr-with-ci-missing-thread",
      tmuxPaneId: "%946",
    });

    await assert.rejects(
      service.registerSubscriptions({
        agentId: agent.agent.agentId,
        sourceId: repoSource.sourceId,
        shortcut: {
          name: "pr",
          args: { number: 93, withCi: true },
        },
      }),
      /requires an existing sibling ci_runs stream/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSubscription rejects multi-member shortcuts and directs callers to registerSubscriptions", async () => {
  const { store, service, dir } = await makeService();
  try {
    const repoSource = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-pr-register-single-thread",
      tmuxPaneId: "%947",
    });

    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agent.agentId,
        sourceId: repoSource.sourceId,
        shortcut: {
          name: "pr",
          args: { number: 93, withCi: true },
        },
      }),
      /use registerSubscriptions\(\) instead/,
    );
    assert.equal(store.listSubscriptions().length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSubscriptions rolls back earlier shortcut members when a later member fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-shortcut-rollback-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const backend = new FailOnNthEnsureConsumerBackend(store, 2);
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input), {
    homeDir: dir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, backend);
  try {
    const repoSource = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "github-pr-rollback-thread",
      tmuxPaneId: "%948",
    });

    await assert.rejects(
      service.registerSubscriptions({
        agentId: agent.agent.agentId,
        sourceId: repoSource.sourceId,
        shortcut: {
          name: "pr",
          args: { number: 93, withCi: true },
        },
      }),
      /ensureConsumer failed for test/,
    );
    assert.equal(store.listSubscriptions().length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote_source module contract rejects non-function optional hooks", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "invalid-hook.mjs"),
      `export default {
  id: "demo.invalid-hook",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      operation_id: "get:/events",
      args: {},
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() {
    return null;
  },
  listSubscriptionShortcuts: []
};`,
      "utf8",
    );

    await assert.rejects(
      service.registerSource({
        sourceType: "remote_source",
        sourceKey: "invalid-hook-demo",
        config: {
          modulePath: "invalid-hook.mjs",
          moduleConfig: {},
        },
      }),
      /listSubscriptionShortcuts must be a function/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeSource rejects when source still has subscriptions", async () => {
  const { store, service, dir } = await makeService();
  try {
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "remove-guard-demo",
      config: {},
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remove-guard-thread",
      tmuxPaneId: "%901",
    });
    await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await assert.rejects(
      service.removeSource(source.sourceId),
      /source remove requires no active subscriptions/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeSource --with-subscriptions removes source together with dependent subscriptions", async () => {
  const { store, service, dir } = await makeService();
  try {
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "remove-with-subscriptions-demo",
      config: {},
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "remove-with-subscriptions-thread",
      tmuxPaneId: "%902",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    const removed = await service.removeSource(source.sourceId, { withSubscriptions: true });

    assert.equal(removed.removed, true);
    assert.equal(removed.sourceId, source.sourceId);
    assert.equal(removed.removedSubscriptions, 1);
    assert.equal(removed.pausedSource, false);
    assert.equal(store.getSource(source.sourceId), null);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
    assert.equal(store.getConsumerBySubscriptionId(subscription.subscriptionId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSource preserves source identity and existing subscriptions", async () => {
  const { store, service, dir } = await makeService();
  try {
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "update-source-demo",
      configRef: "config://before",
      config: { channel: "engineering", enabled: true },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "update-source-thread",
      tmuxPaneId: "%910",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    const updated = await service.updateSource(source.sourceId, {
      configRef: "config://after",
      config: { channel: "infra", enabled: false },
    });

    assert.equal(updated.updated, true);
    assert.equal(updated.source?.sourceId, source.sourceId);
    assert.equal(updated.source?.sourceKey, source.sourceKey);
    assert.equal(updated.source?.configRef, "config://after");
    assert.deepEqual(updated.source?.config, { channel: "infra", enabled: false });
    assert.equal(store.listSubscriptionsForSource(source.sourceId).length, 1);
    assert.equal(store.listSubscriptionsForSource(source.sourceId)[0]?.subscriptionId, subscription.subscriptionId);

    const clearedRef = await service.updateSource(source.sourceId, {
      configRef: null,
    });
    assert.equal(clearedRef.updated, true);
    assert.equal(clearedRef.source?.configRef, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source details expose idle auto-pause state for operators", async () => {
  const { store, service, dir } = await makeService({
    dispatcher: undefined,
    terminalDispatcher: undefined,
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "idle-details.mjs"),
      `export default {
  id: "demo.idle.details",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() { return null; }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "idle-details-demo",
      config: {
        modulePath: "idle-details.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "idle-details-thread",
      tmuxPaneId: "%971",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.removeSubscription(subscription.subscriptionId);
    const idleState = store.getSourceIdleState(source.sourceId);
    store.upsertSourceIdleState({
      ...idleState!,
      autoPauseAt: "2020-01-01T00:00:00.000Z",
      updatedAt: nowIso(),
    });
    await (service as unknown as { runIdleSourceCleanupPass(nowMs: number): Promise<void> }).runIdleSourceCleanupPass(Date.now());

    const details = await service.getSourceDetails(source.sourceId) as {
      source: { status: string };
      idleState: {
        sourceId: string;
        idleSince: string;
        autoPauseAt: string;
        autoPausedAt: string | null;
      };
    };
    assert.equal(details.source.status, "paused");
    assert.equal(details.idleState.sourceId, source.sourceId);
    assert.ok(details.idleState.idleSince);
    assert.ok(details.idleState.autoPauseAt);
    assert.ok(details.idleState.autoPausedAt);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idle source due query skips sources that were already auto-paused", async () => {
  const { store, service, dir } = await makeService();
  try {
    store.upsertSourceIdleState({
      sourceId: "src_due",
      idleSince: "2026-01-01T00:00:00.000Z",
      autoPauseAt: "2026-01-01T00:05:00.000Z",
      autoPausedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.upsertSourceIdleState({
      sourceId: "src_paused",
      idleSince: "2026-01-01T00:00:00.000Z",
      autoPauseAt: "2026-01-01T00:05:00.000Z",
      autoPausedAt: "2026-01-01T00:06:00.000Z",
      updatedAt: "2026-01-01T00:06:00.000Z",
    });

    const due = store.listSourceIdleStatesDue("2026-01-01T00:10:00.000Z");
    assert.deepEqual(
      due.map((state) => state.sourceId),
      ["src_due"],
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid subscription input does not resume an auto-paused source", async () => {
  const { store, service, dir } = await makeService({
    dispatcher: undefined,
    terminalDispatcher: undefined,
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "idle-invalid-filter.mjs"),
      `export default {
  id: "demo.idle.invalid.filter",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() { return null; }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "idle-invalid-filter-demo",
      config: {
        modulePath: "idle-invalid-filter.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "idle-invalid-filter-thread",
      tmuxPaneId: "%972",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });
    await service.removeSubscription(subscription.subscriptionId);
    store.upsertSourceIdleState({
      ...store.getSourceIdleState(source.sourceId)!,
      autoPausedAt: "2026-01-01T00:06:00.000Z",
      updatedAt: "2026-01-01T00:06:00.000Z",
    });
    store.updateSourceRuntime(source.sourceId, { status: "paused" });

    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agent.agentId,
        sourceId: source.sourceId,
        filter: { expr: "metadata[" },
      }),
      /Unexpected|Token|parse|bracket/i,
    );
    assert.equal(service.getSource(source.sourceId).status, "paused");
    assert.ok(store.getSourceIdleState(source.sourceId)?.autoPausedAt);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle gc refreshes idle state when it removes the last subscription", async () => {
  const { store, service, dir } = await makeService({
    dispatcher: undefined,
    terminalDispatcher: undefined,
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "idle-lifecycle.mjs"),
      `export default {
  id: "demo.idle.lifecycle",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() { return null; }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "idle-lifecycle-demo",
      config: {
        modulePath: "idle-lifecycle.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "idle-lifecycle-thread",
      tmuxPaneId: "%973",
    });
    await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      cleanupPolicy: { mode: "at", at: "2020-01-01T00:00:00.000Z" },
      startPolicy: "earliest",
    });

    await (service as unknown as { syncLifecycleGc(): Promise<void> }).syncLifecycleGc();

    assert.equal(service.listSubscriptions({ sourceId: source.sourceId }).length, 0);
    const idleState = store.getSourceIdleState(source.sourceId);
    assert.ok(idleState);
    assert.equal(idleState?.sourceId, source.sourceId);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manual pause does not create idle auto-pause state after the last subscription is removed", async () => {
  const { store, service, dir } = await makeService({
    dispatcher: undefined,
    terminalDispatcher: undefined,
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "idle-manual-pause.mjs"),
      `export default {
  id: "demo.idle.manual.pause",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent() { return null; }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "idle-manual-pause-demo",
      config: {
        modulePath: "idle-manual-pause.mjs",
        moduleConfig: {},
      },
    });
    const agent = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "idle-manual-pause-thread",
      tmuxPaneId: "%974",
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.pauseSource(source.sourceId);
    await service.removeSubscription(subscription.subscriptionId);

    assert.equal(service.getSource(source.sourceId).status, "paused");
    assert.equal(store.getSourceIdleState(source.sourceId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription remove deletes the subscription, its consumer, and transient runtime state", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { store, service, dir } = await makeService({
    dispatcher,
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-remove-sub",
      tmuxPaneId: "%333",
      notifyLeaseMs: 100,
    });
    service.addWebhookActivationTarget(registered.agent.agentId, {
      url: "http://127.0.0.1:9999/webhook",
      activationMode: "activation_with_items",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "remove-sub-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "thread:remove-sub-demo",
      cleanupPolicy: { mode: "on_terminal", gracePeriodSecs: 30 },
      startPolicy: "earliest",
    });

    assert.equal(subscription.trackedResourceRef, "thread:remove-sub-demo");
    assert.deepEqual(subscription.cleanupPolicy, { mode: "on_terminal", gracePeriodSecs: 30 });
    assert.equal(store.getConsumerBySubscriptionId(subscription.subscriptionId)?.subscriptionId, subscription.subscriptionId);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-remove-sub-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(store.listActivationDispatchStatesForAgent(registered.agent.agentId).length > 0, true);
    const removed = await service.removeSubscription(subscription.subscriptionId);
    assert.equal(removed.removed, true);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
    assert.equal(store.getConsumerBySubscriptionId(subscription.subscriptionId), null);
    assert.equal(store.listActivationDispatchStatesForAgent(registered.agent.agentId).length, 0);

    await assert.rejects(
      service.pollSubscription(subscription.subscriptionId),
      /unknown subscription/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription remove preserves unrelated activation dispatch state", async () => {
  const { store, service, dir } = await makeService();
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-remove-sub-state",
      tmuxPaneId: "%334",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "remove-sub-state-demo",
      config: {},
    });
    const first = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      cleanupPolicy: { mode: "manual" },
      startPolicy: "earliest",
    });
    const second = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      cleanupPolicy: { mode: "on_terminal" },
      startPolicy: "earliest",
    });

    store.upsertActivationDispatchState({
      agentId: registered.agent.agentId,
      targetId: registered.terminalTarget.targetId,
      status: "notified",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      lastNotifiedFingerprint: null,
      deferReason: null,
      deferAttempts: 0,
      firstDeferredAt: null,
      lastDeferredAt: null,
      pendingFingerprint: null,
      pendingNewItemCount: 1,
      pendingSummary: "standing-subscription",
      pendingSubscriptionIds: [first.subscriptionId],
      pendingSourceIds: [source.sourceId],
      updatedAt: nowIso(),
    });

    const removed = await service.removeSubscription(second.subscriptionId);
    assert.equal(removed.removed, true);

    const state = store.getActivationDispatchState(
      registered.agent.agentId,
      registered.terminalTarget.targetId,
    );
    assert.ok(state);
    assert.deepEqual(state.pendingSubscriptionIds, [first.subscriptionId]);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription register persists trackedResourceRef and cleanupPolicy", async () => {
  const { store, service, dir } = await makeService();
  try {
    const agent = await registerTmuxAgent(service, "cleanup-policy");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "cleanup-policy-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:373",
      cleanupPolicy: {
        mode: "on_terminal_or_at",
        at: "2026-05-01T00:00:00.000Z",
        gracePeriodSecs: 300,
      },
      startPolicy: "latest",
    });

    assert.equal(subscription.trackedResourceRef, "pr:373");
    assert.deepEqual(subscription.cleanupPolicy, {
      mode: "on_terminal_or_at",
      at: "2026-05-01T00:00:00.000Z",
      gracePeriodSecs: 300,
    });
    assert.deepEqual(store.getSubscription(subscription.subscriptionId)?.cleanupPolicy, subscription.cleanupPolicy);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription register defaults cleanupPolicy to manual", async () => {
  const { store, service, dir } = await makeService();
  try {
    const agent = await registerTmuxAgent(service, "cleanup-default");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "cleanup-default-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "latest",
    });

    assert.equal(subscription.trackedResourceRef, null);
    assert.deepEqual(subscription.cleanupPolicy, { mode: "manual" });
    assert.deepEqual(store.getSubscription(subscription.subscriptionId)?.cleanupPolicy, { mode: "manual" });
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription register rejects invalid cleanupPolicy combinations", async () => {
  const { store, service, dir } = await makeService();
  try {
    const agent = await registerTmuxAgent(service, "cleanup-invalid");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "cleanup-invalid-demo",
      config: {},
    });

    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agentId,
        sourceId: source.sourceId,
        cleanupPolicy: { mode: "manual", at: "2026-05-01T00:00:00.000Z" } as never,
        startPolicy: "latest",
      }),
      /cleanupPolicy mode manual does not allow at or gracePeriodSecs/,
    );
    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agentId,
        sourceId: source.sourceId,
        cleanupPolicy: { mode: "at" } as never,
        startPolicy: "latest",
      }),
      /cleanupPolicy mode at requires a valid ISO8601 at timestamp/,
    );
    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agentId,
        sourceId: source.sourceId,
        cleanupPolicy: { mode: "on_terminal", gracePeriodSecs: -1 } as never,
        startPolicy: "latest",
      }),
      /cleanupPolicy gracePeriodSecs must be a non-negative integer/,
    );
    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agentId,
        sourceId: source.sourceId,
        cleanupPolicy: { mode: "on_terminal", at: "2026-05-01T00:00:00.000Z" } as never,
        startPolicy: "latest",
      }),
      /cleanupPolicy mode on_terminal does not allow at/,
    );
    await assert.rejects(
      service.registerSubscription({
        agentId: agent.agentId,
        sourceId: source.sourceId,
        cleanupPolicy: { mode: "at", at: "2026-05-01" } as never,
        startPolicy: "latest",
      }),
      /cleanupPolicy mode at requires a valid ISO8601 at timestamp/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gc removes subscriptions whose cleanupPolicy deadline has passed", async () => {
  const { store, service, dir } = await makeService();
  try {
    const agent = await registerTmuxAgent(service, "cleanup-deadline");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "cleanup-deadline-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: source.sourceId,
      cleanupPolicy: { mode: "at", at: "2020-01-01T00:00:00.000Z" },
      startPolicy: "latest",
    });

    const result = service.gc();
    assert.equal(result.removedSubscriptions, 1);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
    assert.equal(store.getConsumerBySubscriptionId(subscription.subscriptionId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal lifecycle signals schedule retirements and gc removes matching subscriptions after delivery", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "lifecycle-demo.mjs"),
      `export default {
  id: "demo.lifecycle",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    return { sourceNativeId: String(raw.id), eventVariant: "demo.lifecycle", metadata: { ref: raw.ref }, rawPayload: raw };
  },
  projectLifecycleSignal(raw) {
    if (raw.state !== "closed") return null;
    return { ref: String(raw.ref), terminal: true, state: "closed", result: raw.result ?? null };
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "lifecycle-demo",
      config: {
        modulePath: "lifecycle-demo.mjs",
        moduleConfig: {},
      },
    });
    const agentA = await registerTmuxAgent(service, "lifecycle-a");
    const agentB = await registerTmuxAgent(service, "lifecycle-b");
    const subA = await service.registerSubscription({
      agentId: agentA.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:1",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { payload: { ref: "pr:1" } },
      startPolicy: "earliest",
    });
    const subB = await service.registerSubscription({
      agentId: agentB.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:1",
      cleanupPolicy: { mode: "on_terminal_or_at", at: "2030-01-01T00:00:00.000Z" },
      filter: { payload: { ref: "pr:1" } },
      startPolicy: "earliest",
    });
    const subOther = await service.registerSubscription({
      agentId: agentA.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:2",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { payload: { ref: "pr:2" } },
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-terminal-1",
      eventVariant: "demo.lifecycle",
      metadata: { ref: "pr:1" },
      rawPayload: { id: "evt-terminal-1", ref: "pr:1", state: "closed", result: "merged" },
      occurredAt: "2020-06-01T00:00:00.000Z",
    });

    await service.pollSubscription(subA.subscriptionId);
    await service.pollSubscription(subB.subscriptionId);
    await service.pollSubscription(subOther.subscriptionId);

    assert.equal(service.listInboxItems(agentA.agentId).length, 1);
    assert.equal(service.listInboxItems(agentB.agentId).length, 1);
    assert.equal(store.listSubscriptionLifecycleRetirements().length, 2);

    const gc = service.gc();
    assert.equal(gc.removedSubscriptions, 2);
    assert.equal(store.getSubscription(subA.subscriptionId), null);
    assert.equal(store.getSubscription(subB.subscriptionId), null);
    assert.equal(store.getConsumerBySubscriptionId(subA.subscriptionId), null);
    assert.equal(store.getConsumerBySubscriptionId(subB.subscriptionId), null);
    assert.ok(store.getSubscription(subOther.subscriptionId));
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal lifecycle retirements honor gracePeriodSecs until gc reaches retireAt", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "lifecycle-grace.mjs"),
      `export default {
  id: "demo.lifecycle.grace",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    return { sourceNativeId: String(raw.id), eventVariant: "demo.lifecycle", metadata: {}, rawPayload: raw };
  },
  projectLifecycleSignal(raw) {
    return raw.state === "closed" ? { ref: String(raw.ref), terminal: true, state: "closed" } : null;
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "lifecycle-grace-demo",
      config: {
        modulePath: "lifecycle-grace.mjs",
        moduleConfig: {},
      },
    });
    const agent = await registerTmuxAgent(service, "lifecycle-grace");
    const subscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:9",
      cleanupPolicy: { mode: "on_terminal", gracePeriodSecs: 3600 },
      filter: { payload: { ref: "pr:9" } },
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-terminal-grace",
      eventVariant: "demo.lifecycle",
      metadata: {},
      rawPayload: { id: "evt-terminal-grace", ref: "pr:9", state: "closed" },
      occurredAt: "2026-06-01T00:00:00.000Z",
    });
    await service.pollSubscription(subscription.subscriptionId);

    const scheduled = store.getSubscriptionLifecycleRetirement(subscription.subscriptionId);
    assert.ok(scheduled);
    assert.equal(scheduled?.retireAt, "2026-06-01T01:00:00.000Z");

    const firstGc = service.gc();
    assert.equal(firstGc.removedSubscriptions, 0);
    assert.ok(store.getSubscription(subscription.subscriptionId));

    store.upsertSubscriptionLifecycleRetirement({
      ...scheduled!,
      retireAt: "2020-01-01T00:00:00.000Z",
      updatedAt: nowIso(),
    });
    const secondGc = service.gc();
    assert.equal(secondGc.removedSubscriptions, 1);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
    assert.equal(store.getConsumerBySubscriptionId(subscription.subscriptionId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription filter expr can match nested payload fields and exclude self-authored events", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "expr");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "expr-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      filter: {
        metadata: { channel: "engineering" },
        payload: { "sender.login": "teammate" },
        expr: "payload.sender.login != 'jolestar' && contains(payload.head_commit.message, '[notify-agent]')",
      },
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "expr-evt-1",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: {
        sender: { login: "jolestar" },
        head_commit: { message: "ignore this" },
      },
    });
    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "expr-evt-2",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: {
        sender: { login: "teammate" },
        head_commit: { message: "ship [notify-agent]" },
      },
    });

    const pollResult = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(alpha.agentId);
    assert.equal(pollResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceNativeId, "expr-evt-2");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSubscription rejects invalid filter expressions before persistence", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "invalid-expr");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "invalid-expr-demo",
      config: {},
    });

    await assert.rejects(
      service.registerSubscription({
        agentId: alpha.agentId,
        sourceId: source.sourceId,
        filter: { expr: "payload.sender.login ==" },
      }),
      /token|expression|binary/i,
    );

    assert.equal(service.listSubscriptions({ agentId: alpha.agentId }).length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchInbox receives inserted items without auto-acking them", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "4");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "watch-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    const seenEvents: string[] = [];
    const session = service.watchInbox(alpha.agentId, {}, (event) => {
      seenEvents.push(event.event);
    });
    session.start();

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-watch-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: { text: "watch me" },
    });

    const poll = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(alpha.agentId);
    assert.equal(poll.inboxItemsCreated, 1);
    assert.deepEqual(seenEvents, ["items"]);
    assert.equal(items.length, 1);
    assert.equal(items[0].ackedAt, null);

    session.close();
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inbox read defaults to unacked items and ack through clears a processed batch", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "5");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "ack-through-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    for (const event of [
      { id: "evt-1", occurredAt: "2026-04-01T00:00:00.000Z" },
      { id: "evt-2", occurredAt: "2026-04-01T00:00:01.000Z" },
      { id: "evt-3", occurredAt: "2026-04-01T00:00:02.000Z" },
    ]) {
      await service.appendSourceEventByCaller(source.sourceId, {
        sourceNativeId: event.id,
        eventVariant: "message.created",
        metadata: {},
        rawPayload: { text: event.id },
        occurredAt: event.occurredAt,
      });
    }

    const poll = await service.pollSubscription(subscription.subscriptionId);
    assert.equal(poll.inboxItemsCreated, 3);

    const allItems = service.listInboxItems(alpha.agentId, { includeAcked: true });
    assert.equal(allItems.length, 3);

    const ack = await service.ackInboxItemsThrough(alpha.agentId, allItems[1].itemId);
    assert.equal(ack.acked, 2);

    const unread = service.listInboxItems(alpha.agentId);
    assert.equal(unread.length, 1);
    assert.equal(unread[0].sourceNativeId, "evt-3");

    const history = service.listInboxItems(alpha.agentId, { includeAcked: true });
    assert.equal(history.filter((item) => item.ackedAt !== null).length, 2);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack through matches visible inbox order for same-timestamp items", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "same-ts");
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "same-ts",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    for (const event of ["evt-1", "evt-2", "evt-3", "evt-4"]) {
      await service.appendSourceEventByCaller(source.sourceId, {
        sourceNativeId: event,
        eventVariant: "message.created",
        metadata: {},
        rawPayload: { text: event },
        occurredAt: "2026-04-01T00:00:00.000Z",
      });
    }

    const poll = await service.pollSubscription(subscription.subscriptionId);
    assert.equal(poll.inboxItemsCreated, 4);

    const allItems = service.listInboxItems(alpha.agentId, { includeAcked: true });
    assert.deepEqual(allItems.map((item) => item.sourceNativeId), ["evt-1", "evt-2", "evt-3", "evt-4"]);

    const ack = await service.ackInboxItemsThrough(alpha.agentId, allItems[2]!.itemId);
    assert.equal(ack.acked, 3);

    const unread = service.listInboxItems(alpha.agentId);
    assert.deepEqual(unread.map((item) => item.sourceNativeId), ["evt-4"]);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack through still follows visible order when older binaries left inbox_sequence null", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "same-ts-null-seq");
    const inboxId = (service.getInboxDetailsByAgent(alpha.agentId) as { inbox: { inboxId: string } }).inbox.inboxId;

    for (const event of ["evt-1", "evt-2", "evt-3"]) {
      store.insertInboxItem({
        itemId: `item-${event}`,
        sourceId: "src-manual",
        sourceNativeId: event,
        eventVariant: "message.created",
        inboxId,
        occurredAt: "2026-04-01T00:00:00.000Z",
        metadata: {},
        rawPayload: { text: event },
        deliveryHandle: null,
        ackedAt: null,
      });
    }

    await service.stop();
    store.close();

    const dbPath = path.join(dir, "agentinbox.sqlite");
    const SQL = await initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    });
    const db = new SQL.Database(fs.readFileSync(dbPath));
    db.exec(`update inbox_items set inbox_sequence = null where inbox_id = '${inboxId}';`);
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    const reopened = await makeServiceFromDbPath(dbPath, dir);

    const visible = reopened.service.listInboxItems(alpha.agentId);
    assert.deepEqual(visible.map((item) => item.sourceNativeId), ["evt-1", "evt-2", "evt-3"]);

    const ack = await reopened.service.ackInboxItemsThrough(alpha.agentId, visible[1]!.itemId);
    assert.equal(ack.acked, 2);

    const unread = reopened.service.listInboxItems(alpha.agentId);
    assert.deepEqual(unread.map((item) => item.sourceNativeId), ["evt-3"]);

    await reopened.service.stop();
    reopened.store.close();
  } finally {
    try {
      await service.stop();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github bursts materialize digest snapshot entries when inbox aggregation is enabled", async () => {
  const { service, store } = await makeService();
  try {
    const agent = await service.registerAgent({
      runtimeKind: "codex",
      backend: "tmux",
      tmuxPaneId: "%agg",
    });
    service.updateInboxAggregationPolicy(agent.agent.agentId, {
      enabled: true,
      windowMs: 30_000,
      maxItems: 20,
      maxThreadAgeMs: 60_000,
    });
    const source = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: {},
      cleanupPolicy: { mode: "manual" },
      startPolicy: "earliest",
    });

    for (let index = 1; index <= 3; index += 1) {
      await service.appendSourceEvent({
        sourceId: source.sourceId,
        sourceNativeId: `github-review-${index}`,
        eventVariant: "PullRequestReviewCommentEvent.created",
        metadata: {
          number: 135,
          isPullRequest: true,
          repoFullName: "holon-run/agentinbox",
        },
        rawPayload: { id: index, type: "PullRequestReviewCommentEvent", action: "created" },
      });
    }

    await service.pollSubscription(subscription.subscriptionId);
    await (service as any).syncPendingDigestThreads(true);

    const entries = service.listInboxItems(agent.agent.agentId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "digest_snapshot");
    assert.equal(entries[0]?.count, 3);
    assert.equal(entries[0]?.itemIds.length, 3);
    assert.match(entries[0]?.summary ?? "", /review comments on PR #135/);
  } finally {
    await service.stop();
    store.close();
  }
});

test("acking an older digest snapshot rematerializes a newer visible snapshot", async () => {
  const { service, store } = await makeService();
  try {
    const agent = await service.registerAgent({
      runtimeKind: "codex",
      backend: "tmux",
      tmuxPaneId: "%agg-ack",
    });
    service.updateInboxAggregationPolicy(agent.agent.agentId, {
      enabled: true,
      windowMs: 30_000,
      maxItems: 20,
      maxThreadAgeMs: 60_000,
    });
    const source = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox" },
    });
    const subscription = await service.registerSubscription({
      agentId: agent.agent.agentId,
      sourceId: source.sourceId,
      filter: {},
      cleanupPolicy: { mode: "manual" },
      startPolicy: "earliest",
    });

    for (let index = 1; index <= 2; index += 1) {
      await service.appendSourceEvent({
        sourceId: source.sourceId,
        sourceNativeId: `github-review-a-${index}`,
        eventVariant: "PullRequestReviewCommentEvent.created",
        metadata: { number: 136, isPullRequest: true },
        rawPayload: { id: index, type: "PullRequestReviewCommentEvent", action: "created" },
      });
    }
    await service.pollSubscription(subscription.subscriptionId);
    await (service as any).syncPendingDigestThreads(true);

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "github-review-a-3",
      eventVariant: "PullRequestReviewCommentEvent.created",
      metadata: { number: 136, isPullRequest: true },
      rawPayload: { id: 3, type: "PullRequestReviewCommentEvent", action: "created" },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await (service as any).syncPendingDigestThreads(true);

    const inbox = store.getInboxByAgentId(agent.agent.agentId)!;
    const history = store.listInboxEntries(inbox.inboxId, { includeAcked: true })
      .filter((entry) => entry.kind === "digest_snapshot");
    assert.equal(history.length >= 2, true);
    const older = history[0]!;
    const visibleBefore = service.listInboxItems(agent.agent.agentId);
    assert.equal(visibleBefore.length, 1);
    assert.equal(visibleBefore[0]?.count, 3);

    const ack = await service.ackInboxItems(agent.agent.agentId, [older.entryId]);
    assert.equal(ack.acked, 1);

    const visibleAfter = service.listInboxItems(agent.agent.agentId);
    assert.equal(visibleAfter.length, 1);
    assert.equal(visibleAfter[0]?.kind, "digest_snapshot");
    assert.equal(visibleAfter[0]?.count, 1);
    assert.equal(visibleAfter[0]?.itemIds.length, 1);
  } finally {
    await service.stop();
    store.close();
  }
});

test("direct inbox text messages create inbox items and trigger activation", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { store, service, dir } = await makeService({
    dispatcher,
    terminalDispatcher,
    activationWindowMs: 10,
    activationMaxItems: 1,
  });
  try {
    const alpha = await registerTmuxAgent(service, "63");
    service.addWebhookActivationTarget(alpha.agentId, {
      url: "http://127.0.0.1:9999/direct",
      activationMode: "activation_with_items",
    });

    const delivered = await service.addDirectInboxTextMessage(alpha.agentId, {
      message: "  Review PR #51 CI failure and push a fix.  ",
    }, {
      ...process.env,
      TMUX_PANE: "%63",
      CODEX_THREAD_ID: "thread-63",
      ITERM_SESSION_ID: "",
      TERM_SESSION_ID: "",
      TERM_PROGRAM: "",
    });

    assert.equal(delivered.activated, true);
    const items = service.listInboxItems(alpha.agentId, { includeAcked: true });
    assert.equal(items.length, 1);
    assert.equal(items[0].eventVariant, "agentinbox.direct_text_message");
    assert.deepEqual(items[0].metadata, {});
    assert.deepEqual(items[0].rawPayload, {
      type: "direct_text_message",
      message: "Review PR #51 CI failure and push a fix.",
      sender: alpha.agentId,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(dispatcher.calls.length, 1);
    assert.equal(dispatcher.calls[0].activation.agentId, alpha.agentId);
    assert.equal(dispatcher.calls[0].activation.newItemCount, 1);
    assert.equal(dispatcher.calls[0].activation.items?.[0]?.itemId, delivered.itemId);
    assert.match(dispatcher.calls[0].activation.summary, /from direct_text_message:/);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("direct inbox text messages fail cleanly if the inbox item cannot be persisted", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const { store, service, dir } = await makeService({
    dispatcher,
    activationWindowMs: 10,
    activationMaxItems: 1,
  });
  try {
    const alpha = await registerTmuxAgent(service, "64");
    const originalInsert = store.insertInboxItem.bind(store);
    store.insertInboxItem = () => false;

    await assert.rejects(
      service.addDirectInboxTextMessage(alpha.agentId, {
        message: "This should fail",
      }),
      /failed to persist direct inbox message item/,
    );
    assert.equal(service.listInboxItems(alpha.agentId, { includeAcked: true }).length, 0);
    assert.equal(dispatcher.calls.length, 0);

    store.insertInboxItem = originalInsert;
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSubscription rejects offline agents with no active activation targets", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "notify-sub-offline");
    const agent = service.getAgent(alpha.agentId);
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(alpha.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "runtime gate: runtime_gone",
      updatedAt: offlineAt,
    });
    store.updateAgent(alpha.agentId, {
      status: "offline",
      offlineSince: offlineAt,
      runtimeKind: agent.runtimeKind,
      runtimeSessionId: agent.runtimeSessionId,
      updatedAt: offlineAt,
      lastSeenAt: offlineAt,
    });

    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "notify-sub-offline",
      config: {},
    });

    await assert.rejects(
      service.registerSubscription({
        agentId: alpha.agentId,
        sourceId: source.sourceId,
        startPolicy: "earliest",
      }),
      /not notify-capable: all 1 activation target\(s\) are offline; refusing subscription add to avoid a silent notification black hole/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerTimer rejects offline agents with no active activation targets", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "notify-timer-offline");
    const agent = service.getAgent(alpha.agentId);
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(alpha.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "runtime gate: runtime_gone",
      updatedAt: offlineAt,
    });
    store.updateAgent(alpha.agentId, {
      status: "offline",
      offlineSince: offlineAt,
      runtimeKind: agent.runtimeKind,
      runtimeSessionId: agent.runtimeSessionId,
      updatedAt: offlineAt,
      lastSeenAt: offlineAt,
    });

    assert.throws(
      () => service.registerTimer({
        agentId: alpha.agentId,
        every: 60_000,
        message: "Check the queue",
      }),
      /not notify-capable: all 1 activation target\(s\) are offline; refusing timer add to avoid a silent notification black hole/,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerSubscription and registerTimer allow agents with another active target", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "notify-fallback");
    service.addWebhookActivationTarget(alpha.agentId, {
      url: "http://127.0.0.1:9999/notify-fallback",
      activationMode: "activation_with_items",
    });
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(alpha.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "runtime gate: runtime_gone",
      updatedAt: offlineAt,
    });

    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "notify-fallback",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });
    const timer = service.registerTimer({
      agentId: alpha.agentId,
      every: 60_000,
      message: "Check the queue",
    });

    assert.ok(subscription.subscriptionId);
    assert.equal(subscription.agentId, alpha.agentId);
    assert.ok(timer.scheduleId);
    assert.equal(timer.agentId, alpha.agentId);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("at timers fire once into the inbox and then pause", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const { store, service, dir } = await makeService({
    dispatcher,
    activationWindowMs: 10,
    activationMaxItems: 1,
  });
  try {
    const alpha = await registerTmuxAgent(service, "timer-at");
    service.addWebhookActivationTarget(alpha.agentId, {
      url: "http://127.0.0.1:9999/timer-at",
      activationMode: "activation_with_items",
    });

    const timer = service.registerTimer({
      agentId: alpha.agentId,
      at: "2020-01-01T00:00:00.000Z",
      message: "Prepare today's plan.",
    });
    await (service as unknown as { syncTimers(): Promise<void> }).syncTimers();

    const fired = service.listInboxItems(alpha.agentId, { includeAcked: true });
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0].rawPayload, {
      type: "timer_fired",
      scheduleId: timer.scheduleId,
      message: "Prepare today's plan.",
      sender: "timer",
    });
    assert.equal(service.getTimer(timer.scheduleId).status, "paused");
    assert.equal(service.getTimer(timer.scheduleId).nextFireAt, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every timers advance nextFireAt after firing", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "timer-every");
    const timer = service.registerTimer({
      agentId: alpha.agentId,
      every: 60_000,
      message: "Stand up reminder",
    });
    store.updateTimer(timer.scheduleId, {
      nextFireAt: "2020-01-01T00:00:00.000Z",
      updatedAt: nowIso(),
    });

    await (service as unknown as { syncTimers(): Promise<void> }).syncTimers();

    const updated = service.getTimer(timer.scheduleId);
    assert.equal(updated.status, "active");
    assert.ok(updated.lastFiredAt);
    assert.ok(updated.nextFireAt);
    assert.notEqual(updated.nextFireAt, "2020-01-01T00:00:00.000Z");
    assert.equal(service.listInboxItems(alpha.agentId, { includeAcked: true }).length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent removal and offline GC delete agent timers", async () => {
  const { store, service, dir } = await makeService();
  try {
    const first = await registerTmuxAgent(service, "timer-remove");
    const second = await registerTmuxAgent(service, "timer-gc");

    const firstTimer = service.registerTimer({
      agentId: first.agentId,
      every: 60_000,
      message: "First timer",
    });
    const secondTimer = service.registerTimer({
      agentId: second.agentId,
      cron: "0 8 * * *",
      timezone: "Asia/Shanghai",
      message: "Second timer",
    });

    service.removeAgent(first.agentId);
    assert.equal(store.getTimer(firstTimer.scheduleId), null);
    assert.ok(store.getTimer(secondTimer.scheduleId));

    store.updateAgent(second.agentId, {
      status: "offline",
      offlineSince: "2020-01-01T00:00:00.000Z",
      runtimeKind: "codex",
      runtimeSessionId: "thread-timer-gc",
      updatedAt: nowIso(),
      lastSeenAt: "2020-01-01T00:00:00.000Z",
    });
    service.gc();
    assert.equal(store.getTimer(secondTimer.scheduleId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent removal does not let an in-flight activation recreate dispatch state", async () => {
  const activationGate = new BlockingActivationGate();
  const { store, service, dir } = await makeService({
    activationGate,
    activationWindowMs: 10,
    activationMaxItems: 1,
  });
  try {
    const agent = await registerTmuxAgent(service, "remove-race");

    await service.addDirectInboxTextMessage(agent.agentId, {
      message: "Clean up after this activation starts",
    }, {
      ...process.env,
      TMUX_PANE: "%remove-race",
      CODEX_THREAD_ID: "thread-remove-race",
      ITERM_SESSION_ID: "",
      TERM_SESSION_ID: "",
      TERM_PROGRAM: "",
    });
    await activationGate.waitUntilStarted();

    service.removeAgent(agent.agentId);
    activationGate.unblock("defer", "terminal_busy");
    await sleep(30);

    assert.equal(store.getAgent(agent.agentId), null);
    assert.equal(store.getActivationTarget(agent.targetId), null);
    assert.deepEqual(store.listActivationDispatchStates(), []);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cron timers accept sunday as 7 and leap-day schedules remain active", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "timer-cron");

    const sunday = service.registerTimer({
      agentId: alpha.agentId,
      cron: "0 8 * * 7",
      timezone: "UTC",
      message: "Sunday reminder",
    });
    assert.equal(sunday.status, "active");
    assert.ok(sunday.nextFireAt);

    const leap = service.registerTimer({
      agentId: alpha.agentId,
      cron: "0 0 29 2 *",
      timezone: "UTC",
      message: "Leap reminder",
    });
    assert.equal(leap.status, "active");
    assert.ok(leap.nextFireAt);
    assert.match(leap.nextFireAt ?? "", /^2028-02-29T00:00:00\.000Z$/);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timer firing is idempotent per scheduled occurrence", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "timer-idempotent");
    const timer = service.registerTimer({
      agentId: alpha.agentId,
      every: 60_000,
      message: "Stand up reminder",
    });
    store.updateTimer(timer.scheduleId, {
      nextFireAt: "2020-01-01T00:00:00.000Z",
      updatedAt: nowIso(),
    });

    await (service as unknown as { fireTimer(timer: { scheduleId: string; nextFireAt?: string | null; message: string; sender?: string | null; mode: "every"; intervalMs?: number | null; cronExpr?: string | null; at?: string | null; timezone: string }, now: string): Promise<void> }).fireTimer(
      service.getTimer(timer.scheduleId) as never,
      "2020-01-01T00:00:00.000Z",
    );
    store.updateTimer(timer.scheduleId, {
      nextFireAt: "2020-01-01T00:00:00.000Z",
      updatedAt: nowIso(),
    });
    await (service as unknown as { fireTimer(timer: { scheduleId: string; nextFireAt?: string | null; message: string; sender?: string | null; mode: "every"; intervalMs?: number | null; cronExpr?: string | null; at?: string | null; timezone: string }, now: string): Promise<void> }).fireTimer(
      service.getTimer(timer.scheduleId) as never,
      "2020-01-01T00:00:01.000Z",
    );

    const items = service.listInboxItems(alpha.agentId, { includeAcked: true });
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceNativeId, `${timer.scheduleId}:2020-01-01T00:00:00.000Z`);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compact and gc remove only acked inbox items older than retention", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "6");
    const beta = await registerTmuxAgent(service, "7");
    const alphaInboxId = (service.getInboxDetailsByAgent(alpha.agentId) as { inbox: { inboxId: string } }).inbox.inboxId;
    const betaInboxId = (service.getInboxDetailsByAgent(beta.agentId) as { inbox: { inboxId: string } }).inbox.inboxId;
    const oldAckedAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();

    store.insertInboxItem({
      itemId: "item-alpha-old",
      sourceId: "src-old",
      sourceNativeId: "evt-alpha-old",
      eventVariant: "message.created",
      inboxId: alphaInboxId,
      occurredAt: "2026-04-01T00:00:00Z",
      metadata: {},
      rawPayload: {},
      deliveryHandle: null,
      ackedAt: oldAckedAt,
    });
    store.insertInboxItem({
      itemId: "item-alpha-live",
      sourceId: "src-live",
      sourceNativeId: "evt-alpha-live",
      eventVariant: "message.created",
      inboxId: alphaInboxId,
      occurredAt: "2026-04-01T00:00:01Z",
      metadata: {},
      rawPayload: {},
      deliveryHandle: null,
      ackedAt: null,
    });
    store.insertInboxItem({
      itemId: "item-beta-old",
      sourceId: "src-old",
      sourceNativeId: "evt-beta-old",
      eventVariant: "message.created",
      inboxId: betaInboxId,
      occurredAt: "2026-04-01T00:00:00Z",
      metadata: {},
      rawPayload: {},
      deliveryHandle: null,
      ackedAt: oldAckedAt,
    });

    const compact = service.compactInbox(alpha.agentId);
    assert.equal(compact.deleted, 1);
    assert.equal(service.listRawInboxItems(alpha.agentId, { includeAcked: true }).length, 1);
    assert.equal(service.listRawInboxItems(beta.agentId, { includeAcked: true }).length, 1);

    const gc = service.gcAckedInboxItems();
    assert.equal(gc.deleted, 1);
    assert.equal(service.listRawInboxItems(beta.agentId, { includeAcked: true }).length, 0);
    assert.equal(service.listRawInboxItems(alpha.agentId).length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook and terminal targets share ack-gated notification flow", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { store, service, dir } = await makeService({
    dispatcher,
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-gated",
      tmuxPaneId: "%42",
      notifyLeaseMs: 100,
    });
    service.addWebhookActivationTarget(registered.agent.agentId, {
      url: "http://127.0.0.1:9999/webhook",
      activationMode: "activation_with_items",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-gated",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(dispatcher.calls.length, 1);
    assert.equal(terminalDispatcher.calls.length, 1);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(dispatcher.calls.length, 1);
    assert.equal(terminalDispatcher.calls.length, 1);

    const ack = await service.ackAllInboxItems(registered.agent.agentId);
    assert.equal(ack.acked, 2);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-3",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(dispatcher.calls.length, 2);
    assert.equal(terminalDispatcher.calls.length, 2);
    assert.equal(store.listActivationDispatchStatesForAgent(registered.agent.agentId).length, 2);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("notification thresholds defer activation until minUnackedItems is reached", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { store, service, dir } = await makeService({
    dispatcher,
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-threshold-gated",
      tmuxPaneId: "%420",
      notifyLeaseMs: 100,
      minUnackedItems: 2,
    });
    service.addWebhookActivationTarget(registered.agent.agentId, {
      url: "http://127.0.0.1:9999/webhook",
      activationMode: "activation_with_items",
      notifyLeaseMs: 100,
      minUnackedItems: 2,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-threshold-gated",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-threshold-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(dispatcher.calls.length, 0);
    assert.equal(terminalDispatcher.calls.length, 0);
    const statesAfterFirst = store.listActivationDispatchStatesForAgent(registered.agent.agentId);
    assert.equal(statesAfterFirst.length, 2);
    assert.ok(statesAfterFirst.every((state) => state.status === "dirty" && state.leaseExpiresAt === null));

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-threshold-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(dispatcher.calls.length, 1);
    assert.equal(terminalDispatcher.calls.length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lease reminders stay suppressed while unacked items remain below minUnackedItems", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-threshold-reminder",
      tmuxPaneId: "%421",
      notifyLeaseMs: 50,
      minUnackedItems: 2,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-threshold-reminder",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-threshold-reminder-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 0);
    let state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(state);
    assert.equal(state.status, "dirty");
    assert.equal(state.leaseExpiresAt, null);

    await sleep(70);
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 0);
    state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(state);
    assert.equal(state.status, "dirty");
    assert.equal(state.leaseExpiresAt, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-registering a terminal agent preserves notification policy when flags are omitted", async () => {
  const { service, dir, store } = await makeService({
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-policy-preserve",
      tmuxPaneId: "%422",
      notifyLeaseMs: 250,
      minUnackedItems: 4,
    });

    const rebound = service.registerAgent({
      agentId: registered.agent.agentId,
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-policy-preserve",
      tmuxPaneId: "%422",
    });

    assert.equal(rebound.terminalTarget.targetId, registered.terminalTarget.targetId);
    assert.equal(rebound.terminalTarget.notifyLeaseMs, 250);
    assert.equal(rebound.terminalTarget.minUnackedItems, 4);
    assert.deepEqual(rebound.terminalTarget.notificationPolicy, {
      notifyLeaseMs: 250,
      minUnackedItems: 4,
    });
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal activation prompts use the current unacked inbox total", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-unacked",
      tmuxPaneId: "%52",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-unacked-prompt",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.match(terminalDispatcher.calls[0]!.prompt, /AgentInbox: 1 unacked item in inbox/);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const allItems = service.listInboxItems(registered.agent.agentId, { includeAcked: false });
    assert.equal(allItems.length, 2);

    const ack = await service.ackInboxItemsThrough(registered.agent.agentId, allItems[0]!.itemId);
    assert.equal(ack.acked, 1);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 2);
    assert.match(terminalDispatcher.calls[1]!.prompt, /AgentInbox: 1 unacked item in inbox/);
    assert.doesNotMatch(terminalDispatcher.calls[1]!.prompt, /2 new items arrived/);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single preview-friendly unacked item is inlined into the terminal prompt", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-inline-preview",
      tmuxPaneId: "%56",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-inline-preview",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-inline-preview",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: { message: "Review PR #51 CI failure and push a fix." },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.match(terminalDispatcher.calls[0]!.prompt, /Preview: Review PR #51 CI failure and push a fix\./);
    assert.match(terminalDispatcher.calls[0]!.prompt, /Read the inbox for full details if needed\./);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single non-preview-friendly item falls back to the generic terminal prompt", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-inline-preview-fallback",
      tmuxPaneId: "%57",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-inline-preview-fallback",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-inline-structured",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: { body: "{\"kind\":\"structured\",\"value\":42}" },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.doesNotMatch(terminalDispatcher.calls[0]!.prompt, /Preview:/);
    assert.match(terminalDispatcher.calls[0]!.prompt, /Please read the inbox, process them, and ack when finished\./);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("single github_repo_ci item uses source-specific inline preview in the terminal prompt", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-github-ci-preview",
      tmuxPaneId: "%59",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: {
        owner: "holon-run",
        repo: "agentinbox",
      },
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceNativeId: "workflow_run:101",
      sourceId: source.sourceId,
      eventVariant: "workflow_run.ci.completed.success",
      metadata: {
        repoFullName: "holon-run/agentinbox",
        name: "Node Tests",
        status: "completed",
        conclusion: "success",
        headBranch: "feature/issue-112",
      },
      rawPayload: {
        id: 101,
        name: "Node Tests",
        status: "completed",
        conclusion: "success",
        head_branch: "feature/issue-112",
      },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.match(
      terminalDispatcher.calls[0]!.prompt,
      /Preview: Node Tests completed success for holon-run\/agentinbox on feature\/issue-112\./,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("user-defined remote_source profiles can opt into source-specific inline previews", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "preview-hook.mjs"),
      `export default {
  id: "demo.preview-hook",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      operation_id: "get:/events",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(rawPayload) {
    return {
      sourceNativeId: String(rawPayload.id ?? "evt-remote-preview"),
      eventVariant: "demo.event",
      metadata: {},
      rawPayload
    };
  },
  deriveInlinePreview(item) {
    return item.rawPayload.kind === "build" ? "Remote build finished for demo service" : null;
  }
};\n`,
    );

    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-remote-preview-hook",
      tmuxPaneId: "%60",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "demo/preview-hook",
      config: {
        modulePath: "preview-hook.mjs",
      },
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceNativeId: "evt-remote-preview",
      sourceId: source.sourceId,
      eventVariant: "demo.event",
      metadata: {},
      rawPayload: {
        kind: "build",
        body: "{\"kind\":\"structured\",\"value\":42}",
      },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.match(
      terminalDispatcher.calls[0]!.prompt,
      /Preview: Remote build finished for demo service\./,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source-specific preview hook failures fall back to the generic preview", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "preview-hook-error.mjs"),
      `export default {
  id: "demo.preview-hook-error",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      operation_id: "get:/events",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(rawPayload) {
    return {
      sourceNativeId: String(rawPayload.id ?? "evt-remote-preview-error"),
      eventVariant: "demo.event",
      metadata: {},
      rawPayload
    };
  },
  deriveInlinePreview() {
    throw new Error("broken preview hook");
  }
};\n`,
    );

    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-remote-preview-hook-error",
      tmuxPaneId: "%61",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "demo/preview-hook-error",
      config: {
        modulePath: "preview-hook-error.mjs",
      },
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceNativeId: "evt-remote-preview-error",
      sourceId: source.sourceId,
      eventVariant: "demo.event",
      metadata: {},
      rawPayload: {
        message: "Fallback generic preview still works when the source hook crashes.",
      },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.match(
      terminalDispatcher.calls[0]!.prompt,
      /Preview: Fallback generic preview still works when the source hook crashes\./,
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source-specific previews are normalized at the core call boundary", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "preview-hook-unbounded.mjs"),
      `export default {
  id: "demo.preview-hook-unbounded",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      operation_id: "get:/events",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(rawPayload) {
    return {
      sourceNativeId: String(rawPayload.id ?? "evt-remote-preview-unbounded"),
      eventVariant: "demo.event",
      metadata: {},
      rawPayload
    };
  },
  deriveInlinePreview() {
    return "Line one from source hook\\nLine two should collapse and this sentence is intentionally long so the core normalization path has to truncate it before rendering into the terminal activation prompt.";
  }
};\n`,
    );

    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-remote-preview-unbounded",
      tmuxPaneId: "%62",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "demo/preview-hook-unbounded",
      config: {
        modulePath: "preview-hook-unbounded.mjs",
      },
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceNativeId: "evt-remote-preview-unbounded",
      sourceId: source.sourceId,
      eventVariant: "demo.event",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const prompt = terminalDispatcher.calls[0]!.prompt;
    assert.match(prompt, /Preview: Line one from source hook Line two should collapse/);
    assert.doesNotMatch(prompt, /\n/);
    assert.match(prompt, /\.\.\./);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preview-aware terminal prompts still dedupe unchanged lease reminders", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-inline-preview-dedupe",
      tmuxPaneId: "%58",
      notifyLeaseMs: 50,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-inline-preview-dedupe",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-inline-preview-dedupe",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: { message: "Review PR #51 CI failure and push a fix." },
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const firstPrompt = terminalDispatcher.calls[0]!.prompt;
    assert.match(firstPrompt, /Preview: Review PR #51 CI failure and push a fix\./);

    await sleep(70);
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(state?.lastNotifiedFingerprint);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lease expiry does not repeat identical terminal prompts for unchanged inbox state", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-terminal-reminder-dedupe",
      tmuxPaneId: "%53",
      notifyLeaseMs: 50,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-terminal-reminder-dedupe",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-reminder-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);

    await sleep(70);
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(state);
    assert.equal(state.status, "notified");
    assert.ok(state.leaseExpiresAt);
    assert.ok(Date.parse(state.leaseExpiresAt!) > Date.parse(state.updatedAt));
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dirty terminal reminders re-notify only when the effective prompt changes", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-terminal-reminder-changes",
      tmuxPaneId: "%54",
      notifyLeaseMs: 50,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-terminal-reminder-changes",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-change-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-change-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);

    await sleep(70);
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 2);
    assert.match(terminalDispatcher.calls[1]!.prompt, /AgentInbox: 2 unacked items in inbox/);
    const state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(state?.lastNotifiedFingerprint);
    assert.equal(state?.pendingNewItemCount, 0);
    assert.equal(state?.pendingSummary, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal reminder fingerprints use the canonical unacked item set", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { service, dir, store } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationMaxItems: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-terminal-reminder-canonical-items",
      tmuxPaneId: "%55",
      notifyLeaseMs: 50,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "local-event-terminal-reminder-canonical-items",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-canonical-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    const initialState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(initialState?.lastNotifiedFingerprint);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-canonical-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);

    const allItems = service.listInboxItems(registered.agent.agentId, { includeAcked: false });
    assert.equal(allItems.length, 2);
    await service.ackInboxItemsThrough(registered.agent.agentId, allItems[0]!.itemId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 2);
    const updatedState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId);
    assert.ok(updatedState?.lastNotifiedFingerprint);
    assert.notEqual(updatedState?.lastNotifiedFingerprint, initialState?.lastNotifiedFingerprint);
    assert.match(terminalDispatcher.calls[1]!.prompt, /AgentInbox: 1 unacked item in inbox/);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal target goes offline when dispatch fails and probe confirms disappearance", async () => {
  const terminalDispatcher = new FailingTerminalDispatcher();
  terminalDispatcher.probeResult = false;
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate: new FixedActivationGate("inject", "test"),
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-offline",
      tmuxPaneId: "%84",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "offline-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-offline-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    const agent = service.getAgent(registered.agent.agentId);
    const target = service.listActivationTargets(registered.agent.agentId)[0];
    assert.equal(agent.status, "offline");
    assert.equal(target.status, "offline");
    assert.equal(store.listActivationDispatchStatesForAgent(registered.agent.agentId).length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("busy terminal gate defers activation without counting a dispatch failure", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate: new FixedActivationGate("defer", "terminal_busy"),
  });
  try {
    const registered = service.registerAgent({
      backend: "iterm2",
      runtimeKind: "codex",
      runtimeSessionId: "thread-busy",
      runtimePid: 4242,
      itermSessionId: "SESSION-BUSY",
      termProgram: "iTerm.app",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "busy-gate-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-busy-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 0);
    const target = service.listActivationTargets(registered.agent.agentId)[0];
    assert.equal(target?.kind, "terminal");
    assert.equal(target?.status, "active");
    assert.equal(target?.consecutiveFailures, 0);
    assert.equal(target?.lastError ?? null, null);
    const states = store.listActivationDispatchStatesForAgent(registered.agent.agentId);
    assert.equal(states.length, 1);
    assert.equal(states[0]?.status, "dirty");
    assert.equal(states[0]?.deferReason, "terminal_busy");
    assert.equal(states[0]?.deferAttempts, 1);
    assert.ok(states[0]?.pendingFingerprint);
    assert.equal(states[0]?.pendingNewItemCount, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("busy terminal defer uses capped exponential backoff", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const activationGate = new MutableActivationGate("defer", "terminal_busy");
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate,
  });
  try {
    const registered = service.registerAgent({
      backend: "iterm2",
      runtimeKind: "codex",
      runtimeSessionId: "thread-busy-backoff",
      runtimePid: 4242,
      itermSessionId: "SESSION-BUSY-BACKOFF",
      termProgram: "iTerm.app",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "busy-gate-backoff",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-busy-backoff-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    for (const [attempt, expectedRetryMs] of [[2, 10_000], [3, 20_000], [4, 40_000], [5, 80_000], [6, 160_000], [7, 300_000]] as const) {
      const current = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
      store.upsertActivationDispatchState({
        ...current,
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        updatedAt: nowIso(),
      });
      await (service as any).syncActivationDispatchStates();
      await sleep(20);

      const next = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
      assert.equal(next.deferAttempts, attempt);
      const retryMs = Date.parse(next.leaseExpiresAt!) - Date.now();
      assert.ok(retryMs <= expectedRetryMs && retryMs >= Math.max(0, expectedRetryMs - 10_000));
    }
    const finalState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.equal(finalState.deferReason, "terminal_busy");
    assert.equal(terminalDispatcher.calls.length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unexpected defer reasons are preserved in deferred state", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const activationGate = new MutableActivationGate("defer", "custom_busy_reason");
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate,
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-custom-defer-reason",
      tmuxPaneId: "%139",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "custom-defer-reason",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-custom-defer-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    const state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.equal(state.deferReason, "custom_busy_reason");
    assert.equal(state.deferAttempts, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("busy terminal defer keeps only the latest pending reminder fingerprint", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const activationGate = new MutableActivationGate("defer", "terminal_busy");
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate,
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-busy-latest-only",
      tmuxPaneId: "%137",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "busy-gate-latest-only",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-busy-latest-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    const firstState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    const firstFingerprint = firstState.pendingFingerprint;
    assert.ok(firstFingerprint);

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-busy-latest-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    const secondState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.equal(secondState.pendingFingerprint, null);
    assert.equal(secondState.deferAttempts, 1);

    activationGate.set("inject", "gate_unknown_or_idle");
    store.upsertActivationDispatchState({
      ...secondState,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: nowIso(),
    });
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    assert.match(terminalDispatcher.calls[0]!.prompt, /AgentInbox: 2 unacked items in inbox/);
    const delivered = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.ok(delivered.lastNotifiedFingerprint);
    assert.notEqual(delivered.lastNotifiedFingerprint, firstFingerprint);
    assert.equal(delivered.pendingFingerprint, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gate reopening suppresses duplicate terminal dispatches for an already-notified fingerprint", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const activationGate = new MutableActivationGate("inject", "gate_unknown_or_idle");
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate,
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-busy-duplicate-suppression",
      tmuxPaneId: "%138",
      notifyLeaseMs: 50,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "busy-gate-duplicate-suppression",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-duplicate-suppression-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const notifiedState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.ok(notifiedState.lastNotifiedFingerprint);

    activationGate.set("inject", "gate_unknown_or_idle");
    store.upsertActivationDispatchState({
      ...notifiedState,
      status: "dirty",
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      pendingNewItemCount: 1,
      pendingSummary: "local_event:busy-gate-duplicate-suppression:message.created",
      pendingSubscriptionIds: [subscription.subscriptionId],
      pendingSourceIds: [source.sourceId],
      deferReason: "terminal_busy",
      deferAttempts: 3,
      firstDeferredAt: nowIso(),
      lastDeferredAt: nowIso(),
      pendingFingerprint: notifiedState.lastNotifiedFingerprint,
      updatedAt: nowIso(),
    });
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);
    const suppressedState = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.equal(suppressedState.status, "notified");
    assert.equal(suppressedState.pendingFingerprint, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("successful terminal dispatch suppresses unchanged reinjection even outside the dirty reminder path", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const activationGate = new MutableActivationGate("defer", "terminal_busy");
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate,
  });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-terminal-success-suppress",
      tmuxPaneId: "%140",
      notifyLeaseMs: 50,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "terminal-success-suppress",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-terminal-success-suppress-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 0);

    activationGate.set("inject", "gate_unknown_or_idle");
    const deferred = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    const deferredSummary = deferred.pendingSummary;
    const deferredNewItemCount = deferred.pendingNewItemCount;
    const deferredSubscriptionIds = deferred.pendingSubscriptionIds;
    const deferredSourceIds = deferred.pendingSourceIds;
    store.upsertActivationDispatchState({
      ...deferred,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: nowIso(),
    });
    await (service as any).syncActivationDispatchStates();
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 1);

    const entries = store.listInboxEntries(registered.inbox.inboxId, { includeAcked: false });
    const outcome = await (service as any).dispatchActivationTarget({
      agentId: registered.agent.agentId,
      targetId: registered.terminalTarget.targetId,
      newItemCount: deferredNewItemCount,
      totalUnackedCount: entries.length,
      summary: deferredSummary,
      subscriptionIds: deferredSubscriptionIds,
      sourceIds: deferredSourceIds,
      entries,
    });

    assert.equal(outcome, "suppressed");
    assert.equal(terminalDispatcher.calls.length, 1);
    const state = store.getActivationDispatchState(registered.agent.agentId, registered.terminalTarget.targetId)!;
    assert.equal(state.status, "notified");
    assert.equal(state.pendingFingerprint, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("offline terminal gate marks the target offline before dispatch", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
    activationGate: new FixedActivationGate("offline", "runtime_gone"),
  });
  try {
    const registered = service.registerAgent({
      backend: "iterm2",
      runtimeKind: "codex",
      runtimeSessionId: "thread-gone",
      runtimePid: 9999,
      itermSessionId: "SESSION-GONE",
      termProgram: "iTerm.app",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "offline-gate-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-gone-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);
    await sleep(40);

    assert.equal(terminalDispatcher.calls.length, 0);
    const agent = service.getAgent(registered.agent.agentId);
    const target = service.listActivationTargets(registered.agent.agentId)[0];
    assert.equal(agent.status, "offline");
    assert.equal(target?.status, "offline");
    assert.match(target?.lastError ?? "", /runtime gate: runtime_gone/);
    assert.equal(store.listActivationDispatchStatesForAgent(registered.agent.agentId).length, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeActivationTarget restores an offline terminal target when the terminal is available", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  terminalDispatcher.probeStatusResult = "available";
  const { store, service, dir } = await makeService({ terminalDispatcher });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-resume-ok",
      tmuxPaneId: "%901",
      notifyLeaseMs: 100,
    });
    const target = service.listActivationTargets(registered.agent.agentId)[0];
    assert.equal(target?.kind, "terminal");
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(target!.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 2,
      lastError: "probe bug",
      updatedAt: offlineAt,
    });
    store.updateAgent(registered.agent.agentId, {
      status: "offline",
      offlineSince: offlineAt,
      runtimeKind: registered.agent.runtimeKind,
      runtimeSessionId: registered.agent.runtimeSessionId,
      updatedAt: offlineAt,
      lastSeenAt: offlineAt,
    });

    const resumed = await service.resumeActivationTarget(registered.agent.agentId, target!.targetId);

    assert.deepEqual(resumed, {
      targetId: target!.targetId,
      resumed: true,
      status: "active",
      reason: "terminal_available",
    });
    assert.equal(service.getActivationTarget(target!.targetId).status, "active");
    assert.equal(service.getActivationTarget(target!.targetId).offlineSince, null);
    assert.equal(service.getAgent(registered.agent.agentId).status, "active");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeActivationTarget keeps an offline terminal target offline when the terminal is gone", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  terminalDispatcher.probeStatusResult = "gone";
  const { store, service, dir } = await makeService({ terminalDispatcher });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-resume-gone",
      tmuxPaneId: "%902",
      notifyLeaseMs: 100,
    });
    const target = service.listActivationTargets(registered.agent.agentId)[0];
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(target!.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "terminal unavailable",
      updatedAt: offlineAt,
    });
    store.updateAgent(registered.agent.agentId, {
      status: "offline",
      offlineSince: offlineAt,
      runtimeKind: registered.agent.runtimeKind,
      runtimeSessionId: registered.agent.runtimeSessionId,
      updatedAt: offlineAt,
      lastSeenAt: offlineAt,
    });

    const resumed = await service.resumeActivationTarget(registered.agent.agentId, target!.targetId);

    assert.deepEqual(resumed, {
      targetId: target!.targetId,
      resumed: false,
      status: "offline",
      reason: "terminal_gone",
    });
    assert.equal(service.getActivationTarget(target!.targetId).status, "offline");
    assert.equal(service.getAgent(registered.agent.agentId).status, "offline");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeActivationTarget returns a non-destructive result when terminal probe is unknown", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  terminalDispatcher.probeStatusResult = "unknown";
  const { store, service, dir } = await makeService({ terminalDispatcher });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-resume-unknown",
      tmuxPaneId: "%903",
      notifyLeaseMs: 100,
    });
    const target = service.listActivationTargets(registered.agent.agentId)[0];
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(target!.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "probe unavailable",
      updatedAt: offlineAt,
    });
    store.updateAgent(registered.agent.agentId, {
      status: "offline",
      offlineSince: offlineAt,
      runtimeKind: registered.agent.runtimeKind,
      runtimeSessionId: registered.agent.runtimeSessionId,
      updatedAt: offlineAt,
      lastSeenAt: offlineAt,
    });

    const resumed = await service.resumeActivationTarget(registered.agent.agentId, target!.targetId);

    assert.deepEqual(resumed, {
      targetId: target!.targetId,
      resumed: false,
      status: "offline",
      reason: "probe_unknown",
    });
    const after = service.getActivationTarget(target!.targetId);
    assert.equal(after.status, "offline");
    assert.equal(after.offlineSince, offlineAt);
    assert.equal(after.lastError, "probe unavailable");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeAgent partially recovers mixed offline targets and reconciles agent status", async () => {
  const terminalDispatcher = new RecordingTerminalDispatcher();
  terminalDispatcher.probeStatusResult = "gone";
  const { store, service, dir } = await makeService({ terminalDispatcher });
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-resume-mixed",
      tmuxPaneId: "%904",
      notifyLeaseMs: 100,
    });
    const webhook = service.addWebhookActivationTarget(registered.agent.agentId, {
      url: "http://127.0.0.1:8787/hook",
    });
    const terminal = service.listActivationTargets(registered.agent.agentId).find((target) => target.kind === "terminal");
    const offlineAt = "2026-04-01T00:00:00.000Z";
    store.updateActivationTargetRuntime(terminal!.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "terminal unavailable",
      updatedAt: offlineAt,
    });
    store.updateActivationTargetRuntime(webhook.targetId, {
      status: "offline",
      offlineSince: offlineAt,
      consecutiveFailures: 1,
      lastError: "webhook failure",
      updatedAt: offlineAt,
    });
    store.updateAgent(registered.agent.agentId, {
      status: "offline",
      offlineSince: offlineAt,
      runtimeKind: registered.agent.runtimeKind,
      runtimeSessionId: registered.agent.runtimeSessionId,
      updatedAt: offlineAt,
      lastSeenAt: offlineAt,
    });

    const resumed = await service.resumeAgent(registered.agent.agentId);

    assert.equal(resumed.resumed, true);
    assert.equal(resumed.agent.status, "active");
    assert.equal(resumed.targets.length, 2);
    assert.deepEqual(
      resumed.targets.map((entry) => [entry.targetId, entry.resumed, entry.status, entry.reason]).sort(),
      [
        [terminal!.targetId, false, "offline", "terminal_gone"],
        [webhook.targetId, true, "active", "webhook_resumed"],
      ].sort(),
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("github repo terminal lifecycle fanout retires sibling repo and ci subscriptions by host-scoped trackedResourceRef", async () => {
  const { store, service, dir } = await makeService();
  try {
    const repoSource = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const ciSource = await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const agentA = await registerTmuxAgent(service, "github-fanout-a");
    const agentB = await registerTmuxAgent(service, "github-fanout-b");
    const repoSubscription = await service.registerSubscription({
      agentId: agentA.agentId,
      sourceId: repoSource.sourceId,
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { metadata: { number: 93, isPullRequest: true } },
      startPolicy: "earliest",
    });
    const ciSubscription = await service.registerSubscription({
      agentId: agentB.agentId,
      sourceId: ciSource.sourceId,
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      filter: {},
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: repoSource.sourceId,
      sourceNativeId: "evt-github-terminal-1",
      eventVariant: "PullRequestEvent.closed",
      metadata: { number: 93, isPullRequest: true },
      rawPayload: {
        type: "PullRequestEvent",
        action: "closed",
        pull_request: { number: 93, merged: true },
      },
      occurredAt: "2026-04-19T00:00:00.000Z",
    });

    await service.pollSubscription(repoSubscription.subscriptionId);

    const repoRetirement = store.getSubscriptionLifecycleRetirement(repoSubscription.subscriptionId);
    const ciRetirement = store.getSubscriptionLifecycleRetirement(ciSubscription.subscriptionId);
    assert.ok(repoRetirement);
    assert.ok(ciRetirement);
    assert.equal(repoRetirement?.hostId, repoSource.hostId);
    assert.equal(ciRetirement?.hostId, repoSource.hostId);
    assert.equal(repoRetirement?.trackedResourceRef, "repo:holon-run/agentinbox:pr:93");
    assert.equal(ciRetirement?.trackedResourceRef, "repo:holon-run/agentinbox:pr:93");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store can list subscriptions by host-scoped tracked resource ref", async () => {
  const { store, service, dir } = await makeService();
  try {
    const createdAt = "2026-04-19T00:00:00.000Z";
    store.insertSource({
      sourceId: "src_host_ref_repo",
      hostId: "hst_github_a",
      streamKind: "repo_events",
      streamKey: "holon-run/agentinbox",
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      configRef: null,
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
      status: "active",
      checkpoint: null,
      createdAt,
      updatedAt: createdAt,
    });
    store.insertSource({
      sourceId: "src_host_ref_ci",
      hostId: "hst_github_a",
      streamKind: "ci_runs",
      streamKey: "holon-run/agentinbox",
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      configRef: null,
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
      status: "active",
      checkpoint: null,
      createdAt,
      updatedAt: createdAt,
    });
    store.insertSource({
      sourceId: "src_host_ref_other",
      hostId: "hst_github_b",
      streamKind: "repo_events",
      streamKey: "holon-run/other",
      sourceType: "github_repo",
      sourceKey: "holon-run/other",
      configRef: null,
      config: { owner: "holon-run", repo: "other", uxcAuth: "github-other" },
      status: "active",
      checkpoint: null,
      createdAt,
      updatedAt: createdAt,
    });

    store.insertSubscription({
      subscriptionId: "sub_host_ref_repo",
      agentId: "agt_host_ref",
      sourceId: "src_host_ref_repo",
      filter: {},
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      startPolicy: "earliest",
      startOffset: null,
      startTime: null,
      createdAt,
    });
    store.insertSubscription({
      subscriptionId: "sub_host_ref_ci",
      agentId: "agt_host_ref",
      sourceId: "src_host_ref_ci",
      filter: {},
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      startPolicy: "earliest",
      startOffset: null,
      startTime: null,
      createdAt: "2026-04-19T00:00:01.000Z",
    });
    store.insertSubscription({
      subscriptionId: "sub_host_ref_other",
      agentId: "agt_host_ref",
      sourceId: "src_host_ref_other",
      filter: {},
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      startPolicy: "earliest",
      startOffset: null,
      startTime: null,
      createdAt: "2026-04-19T00:00:02.000Z",
    });

    const matches = store.listSubscriptionsForHostTrackedResourceRef(
      "hst_github_a",
      "repo:holon-run/agentinbox:pr:93",
    );

    assert.deepEqual(
      matches.map((subscription) => subscription.subscriptionId),
      ["sub_host_ref_repo", "sub_host_ref_ci"],
    );
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gc does not retire subscriptions before they consume a terminal event", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "lifecycle-race.mjs"),
      `export default {
  id: "demo.lifecycle.race",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    return { sourceNativeId: String(raw.id), eventVariant: "demo.lifecycle", metadata: {}, rawPayload: raw };
  },
  projectLifecycleSignal(raw) {
    return raw.state === "closed" ? { ref: String(raw.ref), terminal: true, state: "closed" } : null;
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "lifecycle-race-demo",
      config: {
        modulePath: "lifecycle-race.mjs",
        moduleConfig: {},
      },
    });
    const agent = await registerTmuxAgent(service, "lifecycle-race");
    const subscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:77",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { payload: { ref: "pr:77" } },
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-terminal-race",
      eventVariant: "demo.lifecycle",
      metadata: {},
      rawPayload: { id: "evt-terminal-race", ref: "pr:77", state: "closed" },
      occurredAt: "2020-06-01T00:00:00.000Z",
    });

    const firstGc = service.gc();
    assert.equal(firstGc.removedSubscriptions, 0);
    assert.ok(store.getSubscription(subscription.subscriptionId));
    assert.equal(store.getSubscriptionLifecycleRetirement(subscription.subscriptionId), null);

    await service.pollSubscription(subscription.subscriptionId);
    assert.ok(store.getSubscriptionLifecycleRetirement(subscription.subscriptionId));

    const secondGc = service.gc();
    assert.equal(secondGc.removedSubscriptions, 1);
    assert.equal(store.getSubscription(subscription.subscriptionId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gc retires sibling subscriptions sharing a host-scoped trackedResourceRef from one terminal signal", async () => {
  const { store, service, dir } = await makeService();
  try {
    const moduleDir = path.join(dir, "source-modules");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "lifecycle-shared-ref.mjs"),
      `export default {
  id: "demo.lifecycle.shared-ref",
  validateConfig() {},
  buildManagedSourceSpec() {
    return {
      endpoint: "https://example.com",
      mode: "poll",
      poll_config: {
        interval_secs: 30,
        extract_items_pointer: "",
        checkpoint_strategy: { type: "item_key", item_key_pointer: "/id", seen_window: 32 }
      }
    };
  },
  mapRawEvent(raw) {
    return { sourceNativeId: String(raw.id), eventVariant: "demo.lifecycle", metadata: {}, rawPayload: raw };
  },
  projectLifecycleSignal(raw) {
    return raw.state === "closed" ? { ref: String(raw.ref), terminal: true, state: "closed" } : null;
  }
};`,
      "utf8",
    );
    const source = await service.registerSource({
      sourceType: "remote_source",
      sourceKey: "lifecycle-shared-ref-demo",
      config: {
        modulePath: "lifecycle-shared-ref.mjs",
        moduleConfig: {},
      },
    });
    const agentA = await registerTmuxAgent(service, "lifecycle-shared-ref-a");
    const agentB = await registerTmuxAgent(service, "lifecycle-shared-ref-b");
    const subscriptionA = await service.registerSubscription({
      agentId: agentA.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:77",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { payload: { ref: "pr:77" } },
      startPolicy: "earliest",
    });
    const subscriptionB = await service.registerSubscription({
      agentId: agentB.agentId,
      sourceId: source.sourceId,
      trackedResourceRef: "pr:77",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { payload: { ref: "pr:77" } },
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-terminal-shared",
      eventVariant: "demo.lifecycle",
      metadata: {},
      rawPayload: { id: "evt-terminal-shared", ref: "pr:77", state: "closed" },
      occurredAt: "2020-06-01T00:00:00.000Z",
    });

    await service.pollSubscription(subscriptionA.subscriptionId);
    assert.ok(store.getSubscriptionLifecycleRetirement(subscriptionA.subscriptionId));
    assert.ok(store.getSubscriptionLifecycleRetirement(subscriptionB.subscriptionId));

    const firstGc = service.gc();
    assert.equal(firstGc.removedSubscriptions, 2);
    assert.equal(store.getSubscription(subscriptionA.subscriptionId), null);
    assert.equal(store.getSubscription(subscriptionB.subscriptionId), null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription remove does not cascade across sibling subscriptions sharing a host-scoped trackedResourceRef", async () => {
  const { store, service, dir } = await makeService();
  try {
    const repoSource = await service.registerSource({
      sourceType: "github_repo",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const ciSource = await service.registerSource({
      sourceType: "github_repo_ci",
      sourceKey: "holon-run/agentinbox",
      config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
    });
    const agent = await registerTmuxAgent(service, "github-remove-local");
    const repoSubscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: repoSource.sourceId,
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      filter: { metadata: { number: 93, isPullRequest: true } },
      startPolicy: "earliest",
    });
    const ciSubscription = await service.registerSubscription({
      agentId: agent.agentId,
      sourceId: ciSource.sourceId,
      trackedResourceRef: "repo:holon-run/agentinbox:pr:93",
      cleanupPolicy: { mode: "on_terminal" },
      filter: {},
      startPolicy: "earliest",
    });

    const removed = await service.removeSubscription(repoSubscription.subscriptionId);

    assert.equal(removed.removed, true);
    assert.equal(store.getSubscription(repoSubscription.subscriptionId), null);
    assert.ok(store.getSubscription(ciSubscription.subscriptionId));
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent remove cascades local runtime state but keeps shared sources", async () => {
  const { store, service, dir } = await makeService();
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-remove",
      tmuxPaneId: "%85",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "remove-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });
    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-remove-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);

    assert.equal(service.removeAgent(registered.agent.agentId).removed, true);
    assert.equal(store.getAgent(registered.agent.agentId), null);
    assert.equal(store.getInboxByAgentId(registered.agent.agentId), null);
    assert.equal(store.listSubscriptionsForAgent(registered.agent.agentId).length, 0);
    assert.equal(store.listActivationTargetsForAgent(registered.agent.agentId).length, 0);
    assert.equal(store.listSources().length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gc removes offline agents after ttl even with unacked inbox items", async () => {
  const { store, service, dir } = await makeService();
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-gc",
      tmuxPaneId: "%86",
      notifyLeaseMs: 100,
    });
    const source = await service.registerSource({
      sourceType: "local_event",
      sourceKey: "gc-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });
    await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "evt-gc-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.pollSubscription(subscription.subscriptionId);

    const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
    store.updateAgent(registered.agent.agentId, {
      status: "offline",
      offlineSince: old,
      runtimeKind: "codex",
      runtimeSessionId: "thread-gc",
      updatedAt: old,
      lastSeenAt: old,
    });

    const result = service.gc();
    assert.equal(result.removedAgents, 1);
    assert.equal(store.getAgent(registered.agent.agentId), null);
    assert.equal(store.listSources().length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerAgent clears offline and error runtime fields for the current terminal target", async () => {
  const { store, service, dir } = await makeService();
  try {
    const registered = service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-clear",
      tmuxPaneId: "%87",
      notifyLeaseMs: 100,
    });
    const targetId = registered.terminalTarget.targetId;
    store.updateActivationTargetRuntime(targetId, {
      status: "offline",
      offlineSince: "2026-04-01T00:00:00.000Z",
      consecutiveFailures: 3,
      lastDeliveredAt: "2026-04-01T00:00:00.000Z",
      lastError: "stale error",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    store.updateAgent(registered.agent.agentId, {
      status: "offline",
      offlineSince: "2026-04-01T00:00:00.000Z",
      runtimeKind: "codex",
      runtimeSessionId: "thread-clear",
      updatedAt: "2026-04-01T00:00:00.000Z",
      lastSeenAt: "2026-04-01T00:00:00.000Z",
    });

    service.registerAgent({
      backend: "tmux",
      runtimeKind: "codex",
      runtimeSessionId: "thread-clear",
      tmuxPaneId: "%87",
      notifyLeaseMs: 100,
    });

    const target = service.listActivationTargets(registered.agent.agentId)[0];
    const agent = service.getAgent(registered.agent.agentId);
    assert.equal(target.status, "active");
    assert.equal(target.offlineSince, null);
    assert.equal(target.lastError, null);
    assert.equal(target.consecutiveFailures, 0);
    assert.equal(agent.status, "active");
    assert.equal(agent.offlineSince, null);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
