import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { AdapterRegistry } from "../src/adapters";
import { SqliteEventBusBackend } from "../src/backend";
import { Activation, ActivationTarget, AppendSourceEventInput, Subscription, TerminalActivationTarget } from "../src/model";
import { ActivationDispatcher, AgentInboxService } from "../src/service";
import { UxcRemoteSourceClient } from "../src/sources/remote";
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";
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

  override async dispatch(target: TerminalActivationTarget, prompt: string): Promise<void> {
    this.calls.push({ target, prompt });
  }

  override async probe(_target: TerminalActivationTarget): Promise<boolean> {
    return this.probeResult;
  }
}

class FailingTerminalDispatcher extends RecordingTerminalDispatcher {
  override async dispatch(_target: TerminalActivationTarget, _prompt: string): Promise<void> {
    throw new Error("terminal unavailable");
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

async function makeService(options?: {
  dispatcher?: ActivationDispatcher;
  terminalDispatcher?: TerminalDispatcher;
  activationWindowMs?: number;
  activationMaxItems?: number;
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
    new SqliteEventBusBackend(store),
    {
      windowMs: options?.activationWindowMs,
      maxItems: options?.activationMaxItems,
    },
    options?.terminalDispatcher ?? new TerminalDispatcher(async () => ({
      stdout: "",
      stderr: "",
    })),
  );
  return { store, service, dir };
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
  const initialMigrationPath = path.join(__dirname, "..", "drizzle", "migrations", "0000_initial.sql");
  db.exec(fs.readFileSync(initialMigrationPath, "utf8"));
  db.exec("pragma user_version = 12;");
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function readMigrationState(dbPath: string): Promise<{ appliedCount: number; hasNewIndex: boolean }> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
  });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const migrationResult = db.exec("select count(*) as count from __drizzle_migrations;") as Array<{ values: unknown[][] }>;
  const appliedCount = Number(migrationResult[0]?.values?.[0]?.[0] ?? 0);
  const indexResult = db.exec("pragma index_list('inbox_items');") as Array<{ values: unknown[][] }>;
  const hasNewIndex = indexResult.some((set) =>
    set.values.some((row) => String(row[1]) === "idx_inbox_items_source_occurred_at"),
  );
  db.close();
  return { appliedCount, hasNewIndex };
}

test("store migrates a new database using drizzle SQL migrations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-new-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.equal(state.appliedCount, 2);
    assert.equal(state.hasNewIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith("agentinbox.sqlite.backup-"));
    assert.equal(backups.length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store upgrades a legacy v12 database with backup and forward migration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-legacy-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  await createLegacyDb(dbPath);
  const store = await AgentInboxStore.open(dbPath);
  try {
    const state = await readMigrationState(dbPath);
    assert.equal(state.appliedCount, 2);
    assert.equal(state.hasNewIndex, true);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith("agentinbox.sqlite.backup-"));
    assert.equal(backups.length, 1);
  } finally {
    store.close();
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

    assert.equal(first.agent.agentId, "agent_codex_019d57fd65247e20a850a89e81957100");
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
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "demo.mjs"),
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
        profilePath: "demo.mjs",
        profileConfig: {},
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
      supportsTrackedResourceRef: false,
      supportsLifecycleSignals: false,
      shortcuts: [],
    });
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remote_source capability hooks override resolved schema fields and advertise shortcut/lifecycle support", async () => {
  const { store, service, dir } = await makeService();
  try {
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "capabilities.mjs"),
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
        profilePath: "capabilities.mjs",
        profileConfig: {},
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
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "broken-shortcuts.mjs"),
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
        profilePath: "broken-shortcuts.mjs",
        profileConfig: {},
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

test("remote_source profile contract rejects non-function optional hooks", async () => {
  const { store, service, dir } = await makeService();
  try {
    const profileDir = path.join(dir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "invalid-hook.mjs"),
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
          profilePath: "invalid-hook.mjs",
          profileConfig: {},
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
      lifecycleMode: "temporary",
      startPolicy: "earliest",
    });

    assert.equal(subscription.lifecycleMode, "temporary");
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
      lifecycleMode: "standing",
      startPolicy: "earliest",
    });
    const second = await service.registerSubscription({
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      lifecycleMode: "temporary",
      startPolicy: "earliest",
    });

    store.upsertActivationDispatchState({
      agentId: registered.agent.agentId,
      targetId: registered.terminalTarget.targetId,
      status: "notified",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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

    const ack = service.ackInboxItemsThrough(alpha.agentId, allItems[1].itemId);
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
    assert.equal(service.listInboxItems(alpha.agentId, { includeAcked: true }).length, 1);
    assert.equal(service.listInboxItems(beta.agentId, { includeAcked: true }).length, 1);

    const gc = service.gcAckedInboxItems();
    assert.equal(gc.deleted, 1);
    assert.equal(service.listInboxItems(beta.agentId, { includeAcked: true }).length, 0);
    assert.equal(service.listInboxItems(alpha.agentId).length, 1);
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

    const ack = service.ackAllInboxItems(registered.agent.agentId);
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

test("terminal target goes offline when dispatch fails and probe confirms disappearance", async () => {
  const terminalDispatcher = new FailingTerminalDispatcher();
  terminalDispatcher.probeResult = false;
  const { store, service, dir } = await makeService({
    terminalDispatcher,
    activationWindowMs: 20,
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
