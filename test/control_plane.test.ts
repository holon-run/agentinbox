import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { AdapterRegistry } from "../src/adapters";
import { AgentInboxClient } from "../src/client";
import { startControlServer } from "../src/control_server";
import { daemonStatus } from "../src/daemon";
import { createServer } from "../src/http";
import { DEFAULT_AGENTINBOX_PORT, resolveClientTransport, resolveDaemonPaths, resolveServeConfig } from "../src/paths";
import { Activation, InboxItem, RegisterSourceInput, SubscriptionPollResult } from "../src/model";
import { AgentInboxService } from "../src/service";
import { UxcRemoteSourceClient } from "../src/sources/remote";
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";

class FakeRemoteSourceClient implements UxcRemoteSourceClient {
  public readonly ensuredSources: Array<{ namespace: string; sourceKey: string }> = [];
  public readonly stoppedSources: Array<{ namespace: string; sourceKey: string }> = [];
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
    this.ensuredSources.push({ namespace: args.namespace, sourceKey: args.sourceKey });
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

  async sourceStop(namespace: string, sourceKey: string): Promise<void> {
    this.stoppedSources.push({ namespace, sourceKey });
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

function runCli(args: string[], env: NodeJS.ProcessEnv, timeout = 25_000, input?: string) {
  const repoDir = path.resolve(__dirname, "..");
  return spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", ...args], {
    cwd: repoDir,
    env,
    encoding: "utf8",
    timeout,
    input,
  });
}

test("cli version and help subcommands print text output", () => {
  const repoDir = path.resolve(__dirname, "..");
  const version = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "--version"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^agentinbox \d+\.\d+\.\d+/m);

  const helpInbox = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "help", "inbox"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const inboxHelp = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "inbox", "--help"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(helpInbox.status, 0);
  assert.equal(inboxHelp.status, 0);
  assert.match(helpInbox.stdout, /agentinbox inbox/);
  assert.equal(helpInbox.stdout, inboxHelp.stdout);

  const helpSource = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "help", "source"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(helpSource.status, 0);
  assert.match(helpSource.stdout, /agentinbox source schema <sourceId\|sourceType>/);
});

test("resolveServeConfig derives home, db, and socket defaults from AGENTINBOX_HOME", () => {
  const homeDir = path.join(os.tmpdir(), `agentinbox-home-${Date.now()}`);
  const config = resolveServeConfig({
    env: {
      ...process.env,
      AGENTINBOX_HOME: homeDir,
    },
  });

  assert.equal(config.homeDir, homeDir);
  assert.equal(config.dbPath, path.join(homeDir, "agentinbox.sqlite"));
  assert.deepEqual(config.transport, {
    kind: "socket",
    socketPath: path.join(homeDir, "agentinbox.sock"),
  });
});

test("resolveDaemonPaths derives pid and log files from AGENTINBOX_HOME", () => {
  const homeDir = path.join(os.tmpdir(), `agentinbox-daemon-home-${Date.now()}`);
  const paths = resolveDaemonPaths({
    ...process.env,
    AGENTINBOX_HOME: homeDir,
  });
  assert.deepEqual(paths, {
    pidPath: path.join(homeDir, "agentinbox.pid"),
    logPath: path.join(homeDir, "agentinbox.log"),
    metadataPath: path.join(homeDir, "agentinbox.daemon.json"),
  });
});

test("resolveClientTransport prefers the default socket and otherwise falls back to localhost tcp", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-client-home-"));
  try {
    const withoutSocket = resolveClientTransport({
      env: {
        ...process.env,
        AGENTINBOX_HOME: homeDir,
      },
    });
    assert.deepEqual(withoutSocket, {
      kind: "url",
      baseUrl: `http://127.0.0.1:${DEFAULT_AGENTINBOX_PORT}`,
      source: "fallback",
    });

    const socketPath = path.join(homeDir, "agentinbox.sock");
    fs.writeFileSync(socketPath, "");
    const withSocket = resolveClientTransport({
      env: {
        ...process.env,
        AGENTINBOX_HOME: homeDir,
      },
    });
    assert.deepEqual(withSocket, {
      kind: "socket",
      socketPath,
      source: "default",
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("daemonStatus removes stale pid files", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-daemon-status-home-"));
  const pidPath = path.join(homeDir, "agentinbox.pid");
  fs.writeFileSync(pidPath, "999999\n", "utf8");
  try {
    const status = await daemonStatus({
      env: {
        ...process.env,
        AGENTINBOX_HOME: homeDir,
      },
    });
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
    assert.equal(status.logLevel, null);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli auto-starts the daemon for normal commands and daemon stop shuts it down", () => {
  const repoDir = path.resolve(__dirname, "..");
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as { version: string };
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-autostart-home-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
  };
  try {
    const status = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "status"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(status.status, 0, status.stderr);
    const parsedStatus = JSON.parse(status.stdout) as { counts?: { agents?: number } };
    assert.equal(typeof parsedStatus.counts?.agents, "number");

    const daemonState = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "status"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(daemonState.status, 0, daemonState.stderr);
    const parsedDaemon = JSON.parse(daemonState.stdout) as {
      running: boolean;
      pid: number | null;
      logLevel: string | null;
      version: string | null;
      startedAt: string | null;
      command: string | null;
      nodeVersion: string | null;
      pidPath: string;
      logPath: string;
    };
    assert.equal(parsedDaemon.running, true);
    assert.ok(parsedDaemon.pid && parsedDaemon.pid > 0);
    assert.equal(parsedDaemon.logLevel, "info");
    assert.equal(parsedDaemon.version, packageVersion.version);
    assert.equal(typeof parsedDaemon.command, "string");
    assert.ok(parsedDaemon.command && parsedDaemon.command.includes("serve"));
    assert.equal(typeof parsedDaemon.startedAt, "string");
    assert.ok(parsedDaemon.startedAt && !Number.isNaN(Date.parse(parsedDaemon.startedAt)));
    assert.equal(typeof parsedDaemon.pidPath, "string");
    assert.equal(typeof parsedDaemon.logPath, "string");

    const stopped = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "stop"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    const parsedStopped = JSON.parse(stopped.stdout) as { running: boolean };
    assert.equal(parsedStopped.running, false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("daemon status surfaces the configured log level", () => {
  const repoDir = path.resolve(__dirname, "..");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-daemon-log-level-home-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
  };
  try {
    const started = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "start", "--log-level", "debug"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(started.status, 0, started.stderr);

    const daemonState = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "status"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(daemonState.status, 0, daemonState.stderr);
    const parsedDaemon = JSON.parse(daemonState.stdout) as { running: boolean; logLevel: string | null };
    assert.equal(parsedDaemon.running, true);
    assert.equal(parsedDaemon.logLevel, "debug");

    const stopped = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "stop"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
    assert.equal(stopped.status, 0, stopped.stderr);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("unix socket control plane replaces stale socket files and serves requests", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-socket-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  fs.writeFileSync(socketPath, "stale");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const health = await client.request<{ ok: boolean }>("/healthz", undefined, "GET");
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.data, { ok: true });

      const openapi = await client.request<Record<string, unknown>>("/openapi.json", undefined, "GET");
      assert.equal(openapi.statusCode, 200);
      assert.equal(typeof openapi.data.openapi, "string");
      assert.ok(typeof openapi.data.paths === "object");
    } finally {
      await started.close();
    }
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane validates sources/events occurredAt and deliveries/send request shape", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-schema-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    await adapters.start();
    await service.start();
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const sourceResponse = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "local_event",
        sourceKey: "schema-validate-demo",
        config: {},
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const invalidOccurredAt = await client.request<{ error: string }>(
        `/sources/${encodeURIComponent(sourceResponse.data.sourceId)}/events`,
        {
          sourceNativeId: "evt-schema-1",
          eventVariant: "message.created",
          occurredAt: "",
          metadata: {},
          rawPayload: {},
        },
      );
      assert.equal(invalidOccurredAt.statusCode, 400);
      assert.equal(typeof invalidOccurredAt.data.error, "string");

      const invalidDelivery = await client.request<{ error: string }>("/deliveries/send", {
        kind: "comment",
        payload: { body: "hello" },
      });
      assert.equal(invalidDelivery.statusCode, 400);
      assert.equal(typeof invalidDelivery.data.error, "string");

      const mismatchedSend = await client.request<{ error: string }>("/deliveries/send", {
        sourceId: sourceResponse.data.sourceId,
        provider: "github",
        surface: "issue_comment",
        targetRef: "holon-run/agentinbox#111",
        kind: "comment",
        payload: { text: "hello" },
      });
      assert.equal(mismatchedSend.statusCode, 400);
      assert.match(mismatchedSend.data.error, /deliver send is not supported/);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane exposes delivery actions and invoke for remote modules", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-delivery-ops-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "delivery-hook.mjs"),
    `export default {
  id: "demo.delivery-hook",
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
  listDeliveryOperations() {
    return [{
      name: "ack_remote_event",
      title: "Ack Remote Event",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: { body: { type: "string" } }
      }
    }];
  },
  async invokeDeliveryOperation(input) {
    return { status: "sent", note: "invoked " + input.operation + " for " + input.handle.targetRef };
  }
};`,
    "utf8",
  );

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    await adapters.start();
    await service.start();
    const started = await startControlServer(server, { kind: "socket", socketPath });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const sourceResponse = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "remote_source",
        sourceKey: "demo-delivery",
        config: {
          profilePath: "delivery-hook.mjs",
          profileConfig: {},
        },
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const actions = await client.request<{ operations: Array<{ name: string }> }>("/deliveries/actions", {
        sourceId: sourceResponse.data.sourceId,
        provider: "demo",
        surface: "ticket",
        targetRef: "ticket:42",
      });
      assert.equal(actions.statusCode, 200);
      assert.deepEqual(actions.data.operations.map((operation) => operation.name), ["ack_remote_event"]);

      const invoke = await client.request<{ status: string; note: string; operation: string }>("/deliveries/invoke", {
        sourceId: sourceResponse.data.sourceId,
        provider: "demo",
        surface: "ticket",
        targetRef: "ticket:42",
        operation: "ack_remote_event",
        input: { body: "acked" },
      });
      assert.equal(invoke.statusCode, 200);
      assert.equal(invoke.data.status, "sent");
      assert.equal(invoke.data.operation, "ack_remote_event");
      assert.match(invoke.data.note, /invoked ack_remote_event/);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane GET /agents can include activation target summaries", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-agents-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    await adapters.start();
    await service.start();
    const started = await startControlServer(server, { kind: "socket", socketPath });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const agentResponse = await client.request<{
        agent: { agentId: string };
      }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-list",
        tmuxPaneId: "%777",
      });
      assert.equal(agentResponse.statusCode, 200);
      const agentId = agentResponse.data.agent.agentId;

      const targetResponse = await client.request<{ targetId: string }>(`/agents/${encodeURIComponent(agentId)}/targets`, {
        kind: "webhook",
        url: "http://127.0.0.1:9999/webhook",
      });
      assert.equal(targetResponse.statusCode, 200);

      const agentsResponse = await client.request<{
        agents: Array<{
          agent: { agentId: string };
          activationTargets: Array<Record<string, unknown>>;
        }>;
      }>("/agents?include_targets=true", undefined, "GET");
      assert.equal(agentsResponse.statusCode, 200);
      const listed = agentsResponse.data.agents[0];
      assert.ok(listed);
      assert.equal(listed.agent.agentId, agentId);
      assert.equal(Array.isArray(listed.activationTargets), true);
      assert.deepEqual(listed.activationTargets[0], {
        targetId: listed.activationTargets[0]?.targetId,
        kind: "terminal",
        status: "active",
        backend: "tmux",
        tmuxPaneId: "%777",
        tty: null,
        termProgram: null,
        itermSessionId: null,
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-list",
        runtimePid: null,
      });
      assert.equal(listed.activationTargets[1]?.kind, "webhook");
      assert.equal(listed.activationTargets[1]?.status, "active");
      assert.equal("url" in (listed.activationTargets[1] ?? {}), false);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane pause and resume endpoints update source lifecycle", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-pause-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const fake = new FakeRemoteSourceClient();
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: fake,
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "demo-pause.mjs"),
    `export default {
  id: "demo.pause",
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
    return { sourceNativeId: "demo:" + raw.id, eventVariant: "demo.event", metadata: {}, rawPayload: raw };
  }
};`,
    "utf8",
  );

  try {
    await adapters.start();
    await service.start();
    const started = await startControlServer(server, { kind: "socket", socketPath });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const sourceResponse = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "remote_source",
        sourceKey: "pause-http-key",
        config: {
          profilePath: "demo-pause.mjs",
          profileConfig: {},
        },
      });
      assert.equal(sourceResponse.statusCode, 200);
      const sourceId = sourceResponse.data.sourceId;

      const paused = await client.request<{ paused: boolean; source: { status: string } }>(
        `/sources/${encodeURIComponent(sourceId)}/pause`,
        {},
      );
      assert.equal(paused.statusCode, 200);
      assert.equal(paused.data.paused, true);
      assert.equal(paused.data.source.status, "paused");
      assert.deepEqual(fake.stoppedSources, [{
        namespace: "agentinbox",
        sourceKey: "remote_source:pause-http-key",
      }]);

      const resumed = await client.request<{ resumed: boolean; source: { status: string } }>(
        `/sources/${encodeURIComponent(sourceId)}/resume`,
        {},
      );
      assert.equal(resumed.statusCode, 200);
      assert.equal(resumed.data.resumed, true);
      assert.equal(resumed.data.source.status, "active");
      assert.equal(fake.ensuredSources.length, 2);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane can update source config while preserving source identity", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-source-update-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    await adapters.start();
    await service.start();
    const started = await startControlServer(server, { kind: "socket", socketPath });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const sourceResponse = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "local_event",
        sourceKey: "http-update-demo",
        configRef: "config://before",
        config: {
          channel: "engineering",
        },
      });
      assert.equal(sourceResponse.statusCode, 200);
      const sourceId = sourceResponse.data.sourceId;

      const updated = await client.request<{ updated: boolean; source: { sourceId: string; configRef: string; config: { channel: string } } }>(
        `/sources/${encodeURIComponent(sourceId)}`,
        {
          configRef: "config://after",
          config: {
            channel: "infra",
          },
        },
        "PATCH",
      );
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.data.updated, true);
      assert.equal(updated.data.source.sourceId, sourceId);
      assert.equal(updated.data.source.configRef, "config://after");
      assert.deepEqual(updated.data.source.config, { channel: "infra" });

      const cleared = await client.request<{ updated: boolean; source: { configRef: string | null } }>(
        `/sources/${encodeURIComponent(sourceId)}`,
        {
          configRef: null,
        },
        "PATCH",
      );
      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.data.updated, true);
      assert.equal(cleared.data.source.configRef, null);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli resolves current agent, auto-registers session workflows, and warns on cross-session targets", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-current-"));
  const envBase = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
  };
  const envCurrent = {
    ...envBase,
    TMUX_PANE: "%901",
    CODEX_THREAD_ID: "thread-current",
  };
  const envOther = {
    ...envBase,
    TMUX_PANE: "%902",
    CODEX_THREAD_ID: "thread-other",
  };

  try {
    const sourceAdd = runCli(["source", "add", "local_event", "cli-current-demo"], envBase);
    assert.equal(sourceAdd.status, 0, sourceAdd.stderr);
    const source = JSON.parse(sourceAdd.stdout) as { sourceId: string };

    const subscribeCurrent = runCli(["subscription", "add", source.sourceId], envCurrent);
    assert.equal(subscribeCurrent.status, 0, subscribeCurrent.stderr);
    const subscribed = JSON.parse(subscribeCurrent.stdout) as {
      agentId: string;
      autoRegistered?: boolean;
    };
    assert.equal(subscribed.autoRegistered, true);

    const current = runCli(["agent", "current"], envCurrent);
    assert.equal(current.status, 0, current.stderr);
    const currentAgent = JSON.parse(current.stdout) as { agentId: string };
    assert.equal(currentAgent.agentId, subscribed.agentId);

    const otherRegister = runCli(["agent", "register", "--agent-id", "agent-other"], envOther);
    assert.equal(otherRegister.status, 0, otherRegister.stderr);

    const crossSessionRead = runCli(["inbox", "read", "--agent-id", "agent-other"], envCurrent);
    assert.equal(crossSessionRead.status, 0, crossSessionRead.stderr);
    const readResult = JSON.parse(crossSessionRead.stdout) as {
      agentId: string;
      warnings?: Array<{ code: string; currentAgentId: string; requestedAgentId: string }>;
    };
    assert.equal(readResult.agentId, "agent-other");
    assert.deepEqual(readResult.warnings, [{
      code: "cross_session_agent",
      message: "Requested agent does not match the current terminal session.",
      currentAgentId: subscribed.agentId,
      requestedAgentId: "agent-other",
    }]);

    const oldSyntax = runCli(["subscription", "add", "agent-other", source.sourceId], envCurrent);
    assert.notEqual(oldSyntax.status, 0);
    assert.match(oldSyntax.stderr, /usage: agentinbox subscription add <sourceId> \[--agent-id ID]/);
  } finally {
    void runCli(["daemon", "stop"], envBase);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli agent register accepts min-unacked-items", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aix-cli-pol-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%903",
    CODEX_THREAD_ID: "thread-cli-policy",
  };

  try {
    const register = runCli(["agent", "register", "--notify-lease-ms", "200", "--min-unacked-items", "3"], env);
    assert.equal(register.status, 0, register.stderr);
    const payload = JSON.parse(register.stdout) as {
      agent: { agentId: string };
      terminalTarget: { notifyLeaseMs: number; minUnackedItems: number | null };
    };
    assert.equal(payload.terminalTarget.notifyLeaseMs, 200);
    assert.equal(payload.terminalTarget.minUnackedItems, 3);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli source schema resolves source ids to instance schema", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-source-schema-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%936",
    CODEX_THREAD_ID: "thread-source-schema",
  };

  try {
    const sourceAdd = runCli(["source", "add", "local_event", "cli-source-schema-demo"], env);
    assert.equal(sourceAdd.status, 0, sourceAdd.stderr);
    const source = JSON.parse(sourceAdd.stdout) as { sourceId: string };

    const schema = runCli(["source", "schema", source.sourceId], env);
    assert.equal(schema.status, 0, schema.stderr);
    const payload = JSON.parse(schema.stdout) as {
      sourceId: string;
      sourceType: string;
      hostType: string;
      sourceKind: string;
      implementationId: string;
    };
    assert.equal(payload.sourceId, source.sourceId);
    assert.equal(payload.sourceType, "local_event");
    assert.equal(payload.hostType, "local_event");
    assert.equal(payload.sourceKind, "local_event");
    assert.equal(payload.implementationId, "builtin.local_event");
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli source schema preview resolves remote module-backed schemas before registration", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-schema-preview-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%937",
    CODEX_THREAD_ID: "thread-source-schema-preview",
  };

  try {
    const profileDir = path.join(homeDir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "preview.mjs"),
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
      metadataFields: [{ name: "ticketId", type: "string", description: "Ticket id." }]
    };
  }
};`,
      "utf8",
    );

    const schema = runCli([
      "source",
      "schema",
      "preview",
      "remote:demo.preview",
      "--config-json",
      "{\"profilePath\":\"preview.mjs\",\"profileConfig\":{\"token\":\"demo-token\"}}",
    ], env);
    assert.equal(schema.status, 0, schema.stderr);
    const payload = JSON.parse(schema.stdout) as {
      sourceType: string;
      hostType: string;
      sourceKind: string;
      implementationId: string;
      metadataFields: Array<{ name: string }>;
    };
    assert.equal(payload.sourceType, "remote_source");
    assert.equal(payload.hostType, "remote_source");
    assert.equal(payload.sourceKind, "remote:demo.preview");
    assert.equal(payload.implementationId, "demo.preview");
    assert.deepEqual(payload.metadataFields, [{ name: "ticketId", type: "string", description: "Ticket id." }]);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli inbox read rejects unsupported flags like --ack", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-read-flags-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%941",
    CODEX_THREAD_ID: "thread-read-flags",
  };

  try {
    const read = runCli(["inbox", "read", "--ack"], env);
    assert.notEqual(read.status, 0);
    assert.match(read.stderr, /usage: agentinbox inbox read \[--agent-id ID] \[--after-entry ID] \[--include-acked]/);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli inbox send writes a direct text message into the target inbox", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-send-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%963",
    CODEX_THREAD_ID: "thread-send",
  };

  try {
    const register = runCli(["agent", "register"], env);
    assert.equal(register.status, 0, register.stderr);
    const registered = JSON.parse(register.stdout) as { agent: { agentId: string } };

    const send = runCli([
      "inbox",
      "send",
      "--agent-id",
      registered.agent.agentId,
      "--message",
      "Review PR #51 CI failure and push a fix.",
      "--sender",
      "local-script",
    ], env);
    assert.equal(send.status, 0, send.stderr);
    const delivered = JSON.parse(send.stdout) as { itemId: string; inboxId: string; activated: boolean };
    assert.equal(delivered.activated, true);

    const read = runCli(["inbox", "read", "--agent-id", registered.agent.agentId, "--include-acked"], env);
    assert.equal(read.status, 0, read.stderr);
    const payload = JSON.parse(read.stdout) as { items: Array<{ itemId: string; rawPayload: Record<string, unknown> }> };
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].itemId, delivered.itemId);
    assert.deepEqual(payload.items[0].rawPayload, {
      type: "direct_text_message",
      message: "Review PR #51 CI failure and push a fix.",
      sender: "local-script",
    });
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli deliver actions exposes handle-scoped delivery operations", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-deliver-actions-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%9631",
    CODEX_THREAD_ID: "thread-deliver-actions",
  };

  try {
    const result = runCli([
      "deliver",
      "actions",
      "--provider",
      "github",
      "--surface",
      "pull_request_comment",
      "--target",
      "holon-run/agentinbox#111",
    ], env);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { operations: Array<{ name: string }> };
    assert.deepEqual(
      payload.operations.map((operation) => operation.name),
      ["add_comment", "close_issue", "reopen_issue", "merge_pull_request"],
    );
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli deliver invoke requires input-json", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-deliver-invoke-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%9632",
    CODEX_THREAD_ID: "thread-deliver-invoke",
  };

  try {
    const result = runCli([
      "deliver",
      "invoke",
      "--provider",
      "github",
      "--surface",
      "pull_request_comment",
      "--target",
      "holon-run/agentinbox#111",
      "--operation",
      "add_comment",
    ], env);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /usage: agentinbox deliver invoke \(\-\-handle-json JSON \| \-\-provider PROVIDER \-\-surface SURFACE \-\-target TARGET\) \-\-operation NAME \-\-input-json JSON \[\-\-source-id SOURCE_ID\]/,
    );
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli agent resume and target resume commands are available", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-agent-resume-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%964",
    CODEX_THREAD_ID: "thread-agent-resume-cli",
  };

  try {
    const register = runCli(["agent", "register"], env);
    assert.equal(register.status, 0, register.stderr);
    const registered = JSON.parse(register.stdout) as { agent: { agentId: string }; terminalTarget: { targetId: string } };

    const targetResume = runCli([
      "agent",
      "target",
      "resume",
      registered.agent.agentId,
      registered.terminalTarget.targetId,
    ], env);
    assert.equal(targetResume.status, 0, targetResume.stderr);
    const targetPayload = JSON.parse(targetResume.stdout) as { resumed: boolean; status: string; reason: string };
    assert.equal(targetPayload.resumed, false);
    assert.equal(targetPayload.status, "active");
    assert.equal(targetPayload.reason, "already_active");

    const agentResume = runCli(["agent", "resume", registered.agent.agentId], env);
    assert.equal(agentResume.status, 0, agentResume.stderr);
    const agentPayload = JSON.parse(agentResume.stdout) as { resumed: boolean; agent: { status: string }; targets: Array<{ reason: string }> };
    assert.equal(agentPayload.resumed, false);
    assert.equal(agentPayload.agent.status, "active");
    assert.equal(agentPayload.targets[0]?.reason, "already_active");
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli timer add and list manage agent-bound reminder timers", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-timer-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%962",
    CODEX_THREAD_ID: "thread-timer-cli",
  };

  try {
    const register = runCli(["agent", "register"], env);
    assert.equal(register.status, 0, register.stderr);
    const registered = JSON.parse(register.stdout) as { agent: { agentId: string } };

    const add = runCli([
      "timer",
      "add",
      "--agent-id",
      registered.agent.agentId,
      "--every",
      "60m",
      "--message",
      "Daily review reminder",
    ], env);
    assert.equal(add.status, 0, add.stderr);
    const timer = JSON.parse(add.stdout) as { scheduleId: string; mode: string; intervalMs: number };
    assert.equal(timer.mode, "every");
    assert.equal(timer.intervalMs, 3_600_000);

    const listed = runCli(["timer", "list", "--agent-id", registered.agent.agentId], env);
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout) as { timers: Array<{ scheduleId: string; agentId: string }> };
    assert.equal(payload.timers.length, 1);
    assert.equal(payload.timers[0].scheduleId, timer.scheduleId);
    assert.equal(payload.timers[0].agentId, registered.agent.agentId);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli subscription add accepts filter-file and filter-stdin and echoes normalized filter", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-filter-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%931",
    CODEX_THREAD_ID: "thread-filter",
  };

  try {
    const sourceAdd = runCli(["source", "add", "local_event", "cli-filter-demo"], env);
    assert.equal(sourceAdd.status, 0, sourceAdd.stderr);
    const source = JSON.parse(sourceAdd.stdout) as { sourceId: string };

    const filterFilePath = path.join(homeDir, "filter.json");
    fs.writeFileSync(filterFilePath, JSON.stringify({
      metadata: {
        status: "completed",
        nested: {
          branch: "main",
        },
      },
      expr: "metadata.status != 'queued'",
    }, null, 2));

    const fromFile = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-file",
      filterFilePath,
    ], env);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    const fileResult = JSON.parse(fromFile.stdout) as {
      filter: {
        metadata: {
          status: string;
          nested: {
            branch: string;
          };
        };
        expr: string;
      };
    };
    assert.deepEqual(fileResult.filter, {
      metadata: {
        status: "completed",
        nested: {
          branch: "main",
        },
      },
      expr: "metadata.status != 'queued'",
    });

    const fromStdin = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-stdin",
    ], env, 25_000, JSON.stringify({
      payload: {
        review: {
          state: "changes_requested",
        },
      },
      expr: "payload.review.state == 'changes_requested'",
    }));
    assert.equal(fromStdin.status, 0, fromStdin.stderr);
    const stdinResult = JSON.parse(fromStdin.stdout) as {
      filter: {
        payload: {
          review: {
            state: string;
          };
        };
        expr: string;
      };
    };
    assert.deepEqual(stdinResult.filter, {
      payload: {
        review: {
          state: "changes_requested",
        },
      },
      expr: "payload.review.state == 'changes_requested'",
    });

    const conflicting = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-json",
      "{\"metadata\":{\"status\":\"completed\"}}",
      "--filter-file",
      filterFilePath,
    ], env);
    assert.notEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /only one of --filter-json, --filter-file, or --filter-stdin/);

    const emptyObjectJson = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-json",
      "{}",
    ], env);
    assert.notEqual(emptyObjectJson.status, 0);
    assert.match(emptyObjectJson.stderr, /invalid --filter-json: expected a non-empty JSON object/);

    const emptyFilePath = path.join(homeDir, "empty-filter.json");
    fs.writeFileSync(emptyFilePath, "");
    const emptyFile = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-file",
      emptyFilePath,
    ], env);
    assert.notEqual(emptyFile.status, 0);
    assert.match(emptyFile.stderr, /invalid filter file .*empty-filter\.json: expected a non-empty JSON object/);

    const emptyObjectFilePath = path.join(homeDir, "empty-object-filter.json");
    fs.writeFileSync(emptyObjectFilePath, "{}");
    const emptyObjectFile = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-file",
      emptyObjectFilePath,
    ], env);
    assert.notEqual(emptyObjectFile.status, 0);
    assert.match(emptyObjectFile.stderr, /invalid filter file .*empty-object-filter\.json: expected a non-empty JSON object/);

    const emptyStdin = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-stdin",
    ], env, 25_000, "");
    assert.notEqual(emptyStdin.status, 0);
    assert.match(emptyStdin.stderr, /invalid stdin filter: expected a non-empty JSON object/);

    const emptyObjectStdin = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--filter-stdin",
    ], env, 25_000, "{}");
    assert.notEqual(emptyObjectStdin.status, 0);
    assert.match(emptyObjectStdin.stderr, /invalid stdin filter: expected a non-empty JSON object/);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli subscription add supports generic shortcut invocation", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-shortcut-"));
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
    TMUX_PANE: "%932",
    CODEX_THREAD_ID: "thread-shortcut",
  };

  try {
    const store = await AgentInboxStore.open(dbPath);
    const profileDir = path.join(homeDir, "source-profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "cli-shortcut.mjs"),
      `export default {
  id: "demo.cli.shortcut",
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
  mapRawEvent() { return null; },
  listSubscriptionShortcuts() {
    return [{ name: "ticket", description: "Follow one ticket", argsSchema: [{ name: "id", type: "string", required: true, description: "Ticket id." }] }];
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
    const source = {
      sourceId: "src_cli_shortcut_demo",
      sourceType: "remote_source" as const,
      sourceKey: "cli-shortcut-demo",
      configRef: null,
      config: {
        profilePath: "cli-shortcut.mjs",
        profileConfig: {},
      },
      status: "active" as const,
      checkpoint: null,
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    };
    store.insertSource(source);

    const added = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--shortcut",
      "ticket",
      "--shortcut-args-json",
      "{\"id\":\"A-7\"}",
    ], env);
    assert.equal(added.status, 0, added.stderr);
    const payload = JSON.parse(added.stdout) as {
      filter: Record<string, unknown>;
      trackedResourceRef: string | null;
      cleanupPolicy: Record<string, unknown>;
    };
    assert.deepEqual(payload.filter, { metadata: { ticketId: "A-7" } });
    assert.equal(payload.trackedResourceRef, "ticket:A-7");
    assert.deepEqual(payload.cleanupPolicy, { mode: "manual" });

    const conflicting = runCli([
      "subscription",
      "add",
      source.sourceId,
      "--shortcut",
      "ticket",
      "--shortcut-args-json",
      "{\"id\":\"A-7\"}",
      "--filter-json",
      "{\"metadata\":{\"x\":1}}",
    ], env);
    assert.notEqual(conflicting.status, 0);
    assert.match(conflicting.stderr, /shortcut does not allow filter, trackedResourceRef, or cleanupPolicy flags/);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane subscriptions accept generic shortcut invocation", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-shortcut-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "http-shortcut.mjs"),
    `export default {
  id: "demo.http.shortcut",
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
  mapRawEvent() { return null; },
  listSubscriptionShortcuts() {
    return [{ name: "ticket", description: "Follow one ticket", argsSchema: [{ name: "id", type: "string", required: true, description: "Ticket id." }] }];
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

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const source = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "remote_source",
        sourceKey: "http-shortcut-demo",
        config: {
          profilePath: "http-shortcut.mjs",
          profileConfig: {},
        },
      });
      const registered = await client.request<{ agent: { agentId: string } }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "http-shortcut-thread",
        tmuxPaneId: "%950",
      });
      const subscription = await client.request<{
        filter: Record<string, unknown>;
        trackedResourceRef: string | null;
        cleanupPolicy: Record<string, unknown>;
      }>("/subscriptions", {
        agentId: registered.data.agent.agentId,
        sourceId: source.data.sourceId,
        shortcut: {
          name: "ticket",
          args: { id: "A-9" },
        },
      });
      assert.equal(subscription.statusCode, 200);
      assert.deepEqual(subscription.data.filter, { metadata: { ticketId: "A-9" } });
      assert.equal(subscription.data.trackedResourceRef, "ticket:A-9");
      assert.deepEqual(subscription.data.cleanupPolicy, { mode: "manual" });
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane source schema preview resolves remote modules without persistence", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-schema-preview-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "preview.mjs"),
    `export default {
  id: "demo.http.preview",
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
      sourceKind: "remote:demo.http.preview",
      metadataFields: [{ name: "ticketId", type: "string", description: "Ticket id." }]
    };
  }
};`,
    "utf8",
  );

  const store = await AgentInboxStore.open(dbPath);
  const adapters = new AdapterRegistry(store, async () => ({ appended: 0, deduped: 0 }), { homeDir });
  const service = new AgentInboxService(store, adapters);
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const preview = await client.request<{
        sourceType: string;
        hostType: string;
        sourceKind: string;
        implementationId: string;
      }>("/sources/schema-preview", {
        sourceRef: "remote:demo.http.preview",
        config: {
          profilePath: "preview.mjs",
          profileConfig: { token: "demo-token" },
        },
      }, "POST");
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.data.sourceType, "remote_source");
      assert.equal(preview.data.hostType, "remote_source");
      assert.equal(preview.data.sourceKind, "remote:demo.http.preview");
      assert.equal(preview.data.implementationId, "demo.http.preview");
      assert.equal(store.listSources().length, 0);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane source schema preview returns 400 for invalid preview inputs", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-schema-preview-error-"));
  const socketPath = path.join(os.tmpdir(), `aix-preview-${process.pid}-${Date.now()}.sock`);
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "preview-error.mjs"),
    `export default {
  id: "demo.http.preview.error",
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
  mapRawEvent() { return null; }
};`,
    "utf8",
  );

  const store = await AgentInboxStore.open(dbPath);
  const adapters = new AdapterRegistry(store, async () => ({ appended: 0, deduped: 0 }), { homeDir });
  const service = new AgentInboxService(store, adapters);
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const preview = await client.request<{ error: string }>("/sources/schema-preview", {
        sourceRef: "remote:demo.http.preview.error",
        config: {
          profilePath: "preview-error.mjs",
          profileConfig: {},
        },
      }, "POST");
      assert.equal(preview.statusCode, 400);
      assert.match(preview.data.error, /preview failed: preview token required/);
      assert.equal(store.listSources().length, 0);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane shortcut validation errors return 400 instead of 500", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-shortcut-error-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "http-shortcut-error.mjs"),
    `export default {
  id: "demo.http.shortcut.error",
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
  mapRawEvent() { return null; },
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

  const store = await AgentInboxStore.open(dbPath);
  const adapters = new AdapterRegistry(store, async () => ({ appended: 0, deduped: 0 }), { homeDir });
  const service = new AgentInboxService(store, adapters);
  const server = createServer(service);
  let started: Awaited<ReturnType<typeof startControlServer>> | null = null;

  try {
    const source = {
      sourceId: "src_http_shortcut_error_demo",
      sourceType: "remote_source" as const,
      sourceKey: "http-shortcut-error-demo",
      configRef: null,
      config: {
        profilePath: "http-shortcut-error.mjs",
        profileConfig: {},
      },
      status: "active" as const,
      checkpoint: null,
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    };
    store.insertSource(source);
    const registered = service.registerAgent({
      backend: "iterm2",
      runtimeKind: "codex",
      runtimeSessionId: "http-shortcut-error-thread",
      mode: "agent_prompt",
      termProgram: "iTerm.app",
      itermSessionId: "http-shortcut-error-session",
    });

    started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    const client = new AgentInboxClient({
      kind: "socket",
      socketPath,
      source: "flag",
    });

    const response = await client.request<Record<string, unknown>>("/subscriptions", {
      agentId: registered.agent.agentId,
      sourceId: source.sourceId,
      shortcut: { name: "ticket", args: { id: "A-9" } },
      filter: { metadata: { x: 1 } },
    }, "POST");
    assert.equal(response.statusCode, 400);
    assert.match(String(response.data.error), /shortcut does not allow filter, trackedResourceRef, or cleanupPolicy/);
  } finally {
    if (started) {
      await started.close();
    }
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli source pause rejects unsupported local_event sources", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-source-pause-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
  };

  try {
    const sourceAdd = runCli(["source", "add", "local_event", "cli-pause-demo"], env);
    assert.equal(sourceAdd.status, 0, sourceAdd.stderr);
    const source = JSON.parse(sourceAdd.stdout) as { sourceId: string };

    const paused = runCli(["source", "pause", source.sourceId], env);
    assert.notEqual(paused.status, 0);
    assert.match(paused.stderr, /source type local_event does not support pause/);

    const resumed = runCli(["source", "resume", source.sourceId], env);
    assert.notEqual(resumed.status, 0);
    assert.match(resumed.stderr, /source type local_event does not support resume/);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli source update patches config in place", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-cli-source-update-"));
  const env = {
    ...process.env,
    AGENTINBOX_HOME: homeDir,
    ITERM_SESSION_ID: "",
    TERM_SESSION_ID: "",
    TERM_PROGRAM: "",
  };

  try {
    const sourceAdd = runCli([
      "source",
      "add",
      "local_event",
      "cli-update-demo",
      "--config-json",
      "{\"channel\":\"engineering\"}",
    ], env);
    assert.equal(sourceAdd.status, 0, sourceAdd.stderr);
    const source = JSON.parse(sourceAdd.stdout) as { sourceId: string };

    const updated = runCli([
      "source",
      "update",
      source.sourceId,
      "--config-json",
      "{\"channel\":\"infra\"}",
      "--config-ref",
      "config://cli-update",
    ], env);
    assert.equal(updated.status, 0, updated.stderr);
    const updatedPayload = JSON.parse(updated.stdout) as {
      updated: boolean;
      source: {
        sourceId: string;
        configRef: string;
        config: { channel: string };
      };
    };
    assert.equal(updatedPayload.updated, true);
    assert.equal(updatedPayload.source.sourceId, source.sourceId);
    assert.equal(updatedPayload.source.configRef, "config://cli-update");
    assert.deepEqual(updatedPayload.source.config, { channel: "infra" });

    const clearedRef = runCli([
      "source",
      "update",
      source.sourceId,
      "--clear-config-ref",
    ], env);
    assert.equal(clearedRef.status, 0, clearedRef.stderr);
    const clearedPayload = JSON.parse(clearedRef.stdout) as {
      updated: boolean;
      source: {
        configRef: string | null;
      };
    };
    assert.equal(clearedPayload.updated, true);
    assert.equal(clearedPayload.source.configRef, null);
  } finally {
    void runCli(["daemon", "stop"], env);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("e2e control plane can register an agent, route events, watch inbox, and send aggregated activation webhook", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-e2e-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, {
    windowMs: 40,
    maxItems: 20,
  }, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  let resolveWebhook: ((activation: Activation) => void) | null = null;
  const webhookReceived = new Promise<Activation>((resolve) => {
    resolveWebhook = resolve;
  });
  const webhookServer = http.createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Activation;
    res.statusCode = 204;
    res.end(() => {
      resolveWebhook?.(payload);
    });
  });

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      await new Promise<void>((resolve) => {
        webhookServer.listen(0, "127.0.0.1", () => resolve());
      });
      const address = webhookServer.address();
      assert.ok(address && typeof address === "object");
      const webhookUrl = `http://127.0.0.1:${address.port}/activate`;

      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });

      const agentResponse = await client.request<{
        agent: { agentId: string };
        terminalTarget: { targetId: string };
      }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-e2e",
        tmuxPaneId: "%99",
        notifyLeaseMs: 200,
      });
      assert.equal(agentResponse.statusCode, 200);
      const agentId = agentResponse.data.agent.agentId;

      const targetResponse = await client.request<{ targetId: string }>(`/agents/${encodeURIComponent(agentId)}/targets`, {
        kind: "webhook",
        url: webhookUrl,
        activationMode: "activation_only",
      });
      assert.equal(targetResponse.statusCode, 200);

      const sourceResponse = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "local_event",
        sourceKey: "e2e-demo",
        config: {},
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const schemaResponse = await client.request<{ sourceType: string; metadataFields: unknown[] }>(
        "/source-types/github_repo_ci/schema",
        undefined,
        "GET",
      );
      assert.equal(schemaResponse.statusCode, 200);
      assert.equal(schemaResponse.data.sourceType, "github_repo_ci");
      assert.ok(schemaResponse.data.metadataFields.length > 0);

      const subscriptionResponse = await client.request<{
        subscriptionId: string;
        trackedResourceRef: string | null;
        cleanupPolicy: Record<string, unknown>;
      }>("/subscriptions", {
        agentId,
        sourceId: sourceResponse.data.sourceId,
        filter: { metadata: { channel: "engineering" } },
        trackedResourceRef: "pr:69",
        cleanupPolicy: {
          mode: "on_terminal_or_at",
          at: "2026-05-01T00:00:00.000Z",
          gracePeriodSecs: 120,
        },
        startPolicy: "earliest",
      });
      assert.equal(subscriptionResponse.statusCode, 200);
      assert.equal(subscriptionResponse.data.trackedResourceRef, "pr:69");
      assert.deepEqual(subscriptionResponse.data.cleanupPolicy, {
        mode: "on_terminal_or_at",
        at: "2026-05-01T00:00:00.000Z",
        gracePeriodSecs: 120,
      });

      const appendResponse = await client.request<{ appended: number }>(`/sources/${encodeURIComponent(sourceResponse.data.sourceId)}/events`, {
        sourceNativeId: "evt-e2e-1",
        eventVariant: "message.created",
        occurredAt: "2026-04-05T00:00:00Z",
        metadata: { channel: "engineering", subject: "hello" },
        rawPayload: { text: "hello from local event source" },
      });
      assert.equal(appendResponse.statusCode, 200);
      assert.equal(appendResponse.data.appended, 1);

      const pollResponse = await client.request<SubscriptionPollResult>(
        `/subscriptions/${subscriptionResponse.data.subscriptionId}/poll`,
        {},
      );
      assert.equal(pollResponse.statusCode, 200);
      assert.equal(pollResponse.data.inboxItemsCreated, 1);

      const activation = await waitFor(webhookReceived, 1_000, "timed out waiting for activation webhook");
      assert.equal(activation.agentId, agentId);
      assert.equal(activation.targetKind, "webhook");
      assert.equal(activation.newItemCount, 1);

      const inboxResponse = await client.request<{ entries: Array<{ entryId: string }> }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/entries`,
        undefined,
        "GET",
      );
      assert.equal(inboxResponse.statusCode, 200);
      assert.equal(inboxResponse.data.entries.length, 1);

      const ackResponse = await client.request<{ acked: number }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/ack`,
        { throughEntryId: inboxResponse.data.entries[0].entryId },
      );
      assert.equal(ackResponse.statusCode, 200);
      assert.equal(ackResponse.data.acked, 1);

      const unreadAfterAck = await client.request<{ entries: Array<{ entryId: string }> }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/entries`,
        undefined,
        "GET",
      );
      assert.equal(unreadAfterAck.statusCode, 200);
      assert.equal(unreadAfterAck.data.entries.length, 0);

      const historyAfterAck = await client.request<{ entries: Array<{ entryId: string }> }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/entries?include_acked=true`,
        undefined,
        "GET",
      );
      assert.equal(historyAfterAck.statusCode, 200);
      assert.equal(historyAfterAck.data.entries.length, 1);

      const removeSubscriptionResponse = await client.request<{ removed: boolean; subscriptionId: string }>(
        `/subscriptions/${encodeURIComponent(subscriptionResponse.data.subscriptionId)}`,
        undefined,
        "DELETE",
      );
      assert.equal(removeSubscriptionResponse.statusCode, 200);
      assert.equal(removeSubscriptionResponse.data.removed, true);

      const subscriptionsAfterDelete = await client.request<{ subscriptions: Array<{ subscriptionId: string }> }>(
        `/subscriptions?agent_id=${encodeURIComponent(agentId)}`,
        undefined,
        "GET",
      );
      assert.equal(subscriptionsAfterDelete.statusCode, 200);
      assert.equal(subscriptionsAfterDelete.data.subscriptions.length, 0);

      const invalidCleanupPolicyResponse = await client.request<{ error: string }>("/subscriptions", {
        agentId,
        sourceId: sourceResponse.data.sourceId,
        cleanupPolicy: {
          mode: "ephemeral",
        },
      });
      assert.equal(invalidCleanupPolicyResponse.statusCode, 400);
      assert.match(invalidCleanupPolicyResponse.data.error, /unsupported cleanup policy mode/);

    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    webhookServer.close();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane accepts direct inbox text messages and rejects blank payloads", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-direct-http-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, {
    windowMs: 10,
    maxItems: 1,
  }, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  let resolveWebhook: ((activation: Activation) => void) | null = null;
  const webhookReceived = new Promise<Activation>((resolve) => {
    resolveWebhook = resolve;
  });
  const webhookServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Activation;
    res.statusCode = 204;
    res.end(() => {
      resolveWebhook?.(payload);
    });
  });

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      await new Promise<void>((resolve) => {
        webhookServer.listen(0, "127.0.0.1", () => resolve());
      });
      const address = webhookServer.address();
      assert.ok(address && typeof address === "object");
      const webhookUrl = `http://127.0.0.1:${address.port}/activate`;

      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });

      const agentResponse = await client.request<{ agent: { agentId: string } }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-direct-http",
        tmuxPaneId: "%164",
        notifyLeaseMs: 200,
      });
      assert.equal(agentResponse.statusCode, 200);
      const agentId = agentResponse.data.agent.agentId;

      const targetResponse = await client.request<{ targetId: string }>(`/agents/${encodeURIComponent(agentId)}/targets`, {
        kind: "webhook",
        url: webhookUrl,
        activationMode: "activation_with_items",
      });
      assert.equal(targetResponse.statusCode, 200);

      const sendResponse = await client.request<{ itemId: string; inboxId: string; activated: boolean }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/items`,
        {
          message: "Review PR #51 CI failure and push a fix.",
          sender: "local-script",
        },
      );
      assert.equal(sendResponse.statusCode, 200);
      assert.equal(sendResponse.data.activated, true);

      const activation = await waitFor(webhookReceived, 1_000, "timed out waiting for direct inbox activation");
      assert.equal(activation.agentId, agentId);
      assert.equal(activation.newItemCount, 1);
      assert.equal(activation.items?.[0]?.eventVariant, "agentinbox.direct_text_message");

      const inboxResponse = await client.request<{ items: InboxItem[] }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/raw-items?include_acked=true`,
        undefined,
        "GET",
      );
      assert.equal(inboxResponse.statusCode, 200);
      assert.equal(inboxResponse.data.items.length, 1);
      assert.deepEqual(inboxResponse.data.items[0].rawPayload, {
        type: "direct_text_message",
        message: "Review PR #51 CI failure and push a fix.",
        sender: "local-script",
      });

      const invalidResponse = await client.request<{ error: string }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/items`,
        { message: "   " },
      );
      assert.equal(invalidResponse.statusCode, 400);
      assert.match(invalidResponse.data.error, /direct inbox message must not be empty/);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    webhookServer.close();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane accepts notification policy thresholds for agent and webhook targets", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aix-http-pol-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, {
    windowMs: 10,
    maxItems: 1,
  }, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });

      const agentResponse = await client.request<{
        agent: { agentId: string };
        terminalTarget: { notifyLeaseMs: number; minUnackedItems: number | null; notificationPolicy?: { notifyLeaseMs: number; minUnackedItems: number | null } };
      }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-policy-http",
        tmuxPaneId: "%166",
        notifyLeaseMs: 200,
        minUnackedItems: 3,
      });
      assert.equal(agentResponse.statusCode, 200);
      const agentId = agentResponse.data.agent.agentId;
      assert.equal(agentResponse.data.terminalTarget.notifyLeaseMs, 200);
      assert.equal(agentResponse.data.terminalTarget.minUnackedItems, 3);
      assert.deepEqual(agentResponse.data.terminalTarget.notificationPolicy, {
        notifyLeaseMs: 200,
        minUnackedItems: 3,
      });

      const targetResponse = await client.request<{
        targetId: string;
        notifyLeaseMs: number;
        minUnackedItems: number | null;
        notificationPolicy?: { notifyLeaseMs: number; minUnackedItems: number | null };
      }>(`/agents/${encodeURIComponent(agentId)}/targets`, {
        kind: "webhook",
        url: "http://127.0.0.1:9999/activate",
        activationMode: "activation_only",
        notifyLeaseMs: 300,
        minUnackedItems: 5,
      });
      assert.equal(targetResponse.statusCode, 200);
      assert.equal(targetResponse.data.notifyLeaseMs, 300);
      assert.equal(targetResponse.data.minUnackedItems, 5);
      assert.deepEqual(targetResponse.data.notificationPolicy, {
        notifyLeaseMs: 300,
        minUnackedItems: 5,
      });
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane exposes timer lifecycle endpoints and timer firing writes inbox items", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-timer-http-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, {
    windowMs: 10,
    maxItems: 1,
  }, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });

      const agentResponse = await client.request<{ agent: { agentId: string } }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-timer-http",
        tmuxPaneId: "%165",
        notifyLeaseMs: 200,
      });
      assert.equal(agentResponse.statusCode, 200);
      const agentId = agentResponse.data.agent.agentId;

      const addResponse = await client.request<{ scheduleId: string; mode: string; status: string }>(
        "/timers",
        {
          agentId,
          at: "2020-01-01T00:00:00.000Z",
          message: "Prepare today's task plan.",
        },
      );
      assert.equal(addResponse.statusCode, 200);
      assert.equal(addResponse.data.mode, "at");
      const scheduleId = addResponse.data.scheduleId;

      const listResponse = await client.request<{ timers: Array<{ scheduleId: string }> }>(
        `/timers?agent_id=${encodeURIComponent(agentId)}`,
        undefined,
        "GET",
      );
      assert.equal(listResponse.statusCode, 200);
      assert.equal(listResponse.data.timers.length, 1);

      await (service as unknown as { syncTimers(): Promise<void> }).syncTimers();
      const inboxResponse = await client.request<{ items: InboxItem[] }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/raw-items?include_acked=true`,
        undefined,
        "GET",
      );
      assert.equal(inboxResponse.statusCode, 200);
      assert.equal(inboxResponse.data.items.length, 1);
      assert.deepEqual(inboxResponse.data.items[0].rawPayload, {
        type: "timer_fired",
        scheduleId,
        message: "Prepare today's task plan.",
        sender: "timer",
      });

      const resumeResponse = await client.request<{ error: string }>(
        `/timers/${encodeURIComponent(scheduleId)}/resume`,
        {},
      );
      assert.equal(resumeResponse.statusCode, 400);

      const removeResponse = await client.request<{ removed: boolean; scheduleId: string }>(
        `/timers/${encodeURIComponent(scheduleId)}`,
        undefined,
        "DELETE",
      );
      assert.equal(removeResponse.statusCode, 200);
      assert.equal(removeResponse.data.removed, true);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane exposes inbox compact and global gc endpoints", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-gc-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);
  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const agentResponse = await client.request<{
        agent: { agentId: string };
      }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-gc",
        tmuxPaneId: "%55",
        notifyLeaseMs: 200,
      });
      assert.equal(agentResponse.statusCode, 200);
      const agentId = agentResponse.data.agent.agentId;
      const inboxId = `inbox_${agentId}`;
      const oldAckedAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();

      store.insertInboxItem({
        itemId: "item-old",
        sourceId: "src-old",
        sourceNativeId: "evt-old",
        eventVariant: "message.created",
        inboxId,
        occurredAt: "2026-04-01T00:00:00Z",
        metadata: {},
        rawPayload: {},
        deliveryHandle: null,
        ackedAt: oldAckedAt,
      });
      store.insertInboxItem({
        itemId: "item-live",
        sourceId: "src-live",
        sourceNativeId: "evt-live",
        eventVariant: "message.created",
        inboxId,
        occurredAt: "2026-04-01T00:00:01Z",
        metadata: {},
        rawPayload: {},
        deliveryHandle: null,
        ackedAt: null,
      });

      const compactResponse = await client.request<{ deleted: number; retentionMs: number }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/compact`,
        {},
      );
      assert.equal(compactResponse.statusCode, 200);
      assert.equal(compactResponse.data.deleted, 1);

      const compactRead = await client.request<{ items: InboxItem[] }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/raw-items?include_acked=true`,
        undefined,
        "GET",
      );
      assert.equal(compactRead.statusCode, 200);
      assert.equal(compactRead.data.items.length, 1);

      store.insertInboxItem({
        itemId: "item-old-global",
        sourceId: "src-old-global",
        sourceNativeId: "evt-old-global",
        eventVariant: "message.created",
        inboxId,
        occurredAt: "2026-04-01T00:00:02Z",
        metadata: {},
        rawPayload: {},
        deliveryHandle: null,
        ackedAt: oldAckedAt,
      });

      const gcResponse = await client.request<{ deleted: number; retentionMs: number }>(
        "/gc",
        {},
      );
      assert.equal(gcResponse.statusCode, 200);
      assert.equal(gcResponse.data.deleted, 1);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane can remove agents and gc stale offline agents", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-gc-"));
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
  const server = createServer(service);
  await adapters.start();
  await service.start();
  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const agentResponse = await client.request<{
        agent: { agentId: string };
      }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-remove-http",
        tmuxPaneId: "%199",
        notifyLeaseMs: 200,
      });
      const agentId = agentResponse.data.agent.agentId;

      const removeResponse = await client.request<{ removed: boolean }>(
        `/agents/${encodeURIComponent(agentId)}`,
        undefined,
        "DELETE",
      );
      assert.equal(removeResponse.statusCode, 200);
      assert.equal(removeResponse.data.removed, true);

      const stale = service.registerAgent({
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-stale-http",
        tmuxPaneId: "%200",
        notifyLeaseMs: 200,
      });
      const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
      store.updateAgent(stale.agent.agentId, {
        status: "offline",
        offlineSince: old,
        runtimeKind: stale.agent.runtimeKind,
        runtimeSessionId: stale.agent.runtimeSessionId,
        updatedAt: old,
        lastSeenAt: old,
      });

      const gcResponse = await client.request<{ removedAgents: number } & { deleted?: number }>("/gc", {});
      assert.equal(gcResponse.statusCode, 200);
      assert.equal(gcResponse.data.removedAgents, 1);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane exposes target and agent resume for offline recovery", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-resume-"));
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  const terminalDispatcher = new class extends TerminalDispatcher {
    override async probeStatus(): Promise<"available" | "gone" | "unknown"> {
      return "available";
    }
  }(async () => ({ stdout: "", stderr: "" }));
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, terminalDispatcher);
  const server = createServer(service);
  await adapters.start();
  await service.start();
  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const registered = await client.request<{ agent: { agentId: string } }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-resume",
        tmuxPaneId: "%950",
        notifyLeaseMs: 200,
      });
      const agentId = registered.data.agent.agentId;
      const target = service.listActivationTargets(agentId)[0];
      const offlineAt = "2026-04-01T00:00:00.000Z";
      store.updateActivationTargetRuntime(target!.targetId, {
        status: "offline",
        offlineSince: offlineAt,
        consecutiveFailures: 2,
        lastError: "probe bug",
        updatedAt: offlineAt,
      });
      store.updateAgent(agentId, {
        status: "offline",
        offlineSince: offlineAt,
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-resume",
        updatedAt: offlineAt,
        lastSeenAt: offlineAt,
      });

      const targetResume = await client.request<{ resumed: boolean; status: string; reason: string }>(
        `/agents/${encodeURIComponent(agentId)}/targets/${encodeURIComponent(target!.targetId)}/resume`,
        {},
      );
      assert.equal(targetResume.statusCode, 200);
      assert.equal(targetResume.data.resumed, true);
      assert.equal(targetResume.data.status, "active");
      assert.equal(targetResume.data.reason, "terminal_available");

      store.updateActivationTargetRuntime(target!.targetId, {
        status: "offline",
        offlineSince: offlineAt,
        consecutiveFailures: 1,
        lastError: "probe bug again",
        updatedAt: offlineAt,
      });
      store.updateAgent(agentId, {
        status: "offline",
        offlineSince: offlineAt,
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-resume",
        updatedAt: offlineAt,
        lastSeenAt: offlineAt,
      });

      const agentResume = await client.request<{ resumed: boolean; agent: { status: string }; targets: Array<{ resumed: boolean }> }>(
        `/agents/${encodeURIComponent(agentId)}/resume`,
        {},
      );
      assert.equal(agentResume.statusCode, 200);
      assert.equal(agentResume.data.resumed, true);
      assert.equal(agentResume.data.agent.status, "active");
      assert.equal(agentResume.data.targets.length, 1);
      assert.equal(agentResume.data.targets[0]?.resumed, true);
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane accepts caller-supplied agent ids and rejects conflicting rebinds without force", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-http-agent-id-"));
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const store = await AgentInboxStore.open(dbPath);
  const adapters = new AdapterRegistry(store, async () => ({ appended: 0, deduped: 0 }));
  const service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  try {
    await adapters.start();
    await service.start();
    const server = createServer(service);
    const started = await startControlServer(server, { kind: "socket", socketPath });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const first = await client.request<{ agent: { agentId: string } }>("/agents", {
        agentId: "agent-http-alpha",
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-alpha",
        tmuxPaneId: "%601",
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.data.agent.agentId, "agent-http-alpha");

      const conflict = await client.request<{ error: string }>("/agents", {
        agentId: "agent-http-alpha",
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-alpha-rebound",
        tmuxPaneId: "%602",
      });
      assert.equal(conflict.statusCode, 400);
      assert.match(conflict.data.error, /agent register conflict/);

      const invalidForceRebind = await client.request<{ error: string }>("/agents", {
        agentId: "agent-http-alpha",
        forceRebind: "false",
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-alpha-rebound",
        tmuxPaneId: "%602",
      });
      assert.equal(invalidForceRebind.statusCode, 400);
      assert.match(invalidForceRebind.data.error, /expected boolean/);

      const rebound = await client.request<{ terminalTarget: { tmuxPaneId: string | null } }>("/agents", {
        agentId: "agent-http-alpha",
        forceRebind: true,
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "thread-http-alpha-rebound",
        tmuxPaneId: "%602",
      });
      assert.equal(rebound.statusCode, 200);
      assert.equal(rebound.data.terminalTarget.tmuxPaneId, "%602");
    } finally {
      await started.close();
    }
  } finally {
    await adapters.stop();
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane accepts remote_source registration", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-remote-src-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "demo.mjs"),
    `export default {
  id: "demo.control",
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

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const invalid = await client.request<{ error: string }>("/sources", {
        sourceType: "remote_source",
        sourceKey: "invalid-remote",
        config: {},
      });
      assert.equal(invalid.statusCode, 400);
      assert.match(invalid.data.error, /remote_source requires config.profilePath/);

      const response = await client.request<{ error: string }>("/sources", {
        sourceType: "remote_source",
        sourceKey: "remote-demo",
        config: {
          profilePath: "demo.mjs",
          profileConfig: {},
        },
      });
      assert.equal(response.statusCode, 200);
      const sourceId = (response.data as { sourceId?: string; source?: { sourceId?: string } }).sourceId
        ?? (response.data as { source?: { sourceId?: string } }).source?.sourceId;
      assert.equal(typeof sourceId, "string");

      const details = await client.request<{
        resolvedIdentity: { hostType: string; sourceKind: string; implementationId: string };
        schema: { sourceId: string; hostType: string; sourceKind: string; implementationId: string };
      }>(`/sources/${encodeURIComponent(sourceId!)}`, undefined, "GET");
      assert.equal(details.statusCode, 200);
      assert.deepEqual(details.data.resolvedIdentity, {
        hostType: "remote_source",
        sourceKind: "remote:demo.control",
        implementationId: "demo.control",
      });
      assert.equal(details.data.schema.sourceId, sourceId);
      assert.equal(details.data.schema.sourceKind, "remote:demo.control");

      const schema = await client.request<{
        sourceId: string;
        sourceType: string;
        hostType: string;
        sourceKind: string;
        implementationId: string;
      }>(`/sources/${encodeURIComponent(sourceId!)}/schema`, undefined, "GET");
      assert.equal(schema.statusCode, 200);
      assert.equal(schema.data.sourceId, sourceId);
      assert.equal(schema.data.sourceType, "remote_source");
      assert.equal(schema.data.hostType, "remote_source");
      assert.equal(schema.data.sourceKind, "remote:demo.control");
      assert.equal(schema.data.implementationId, "demo.control");

      const removed = await client.request<{ removed: boolean }>(`/sources/${encodeURIComponent(sourceId!)}`, undefined, "DELETE");
      assert.equal(removed.statusCode, 200);
      assert.equal(removed.data.removed, true);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane source details degrade when remote_source resolution fails but instance schema reports an error", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-remote-resolve-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const profileDir = path.join(homeDir, "source-profiles");
  fs.mkdirSync(profileDir, { recursive: true });

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });

      const sourceId = "src_missing_profile";
      store.insertSource({
        sourceId,
        sourceType: "remote_source",
        sourceKey: "resolve-demo",
        configRef: null,
        config: {
          profilePath: "missing.mjs",
          profileConfig: {},
        },
        status: "active",
        checkpoint: null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      });

      const details = await client.request<{
        source: { sourceId: string };
        resolvedIdentity: null;
        resolutionError: string;
        schema: { sourceType: string };
      }>(`/sources/${encodeURIComponent(sourceId)}`, undefined, "GET");
      assert.equal(details.statusCode, 200);
      assert.equal(details.data.source.sourceId, sourceId);
      assert.equal(details.data.resolvedIdentity, null);
      assert.match(details.data.resolutionError, /remote_source module not found/);
      assert.equal(details.data.schema.sourceType, "remote_source");

      const schema = await client.request<{ error: string }>(`/sources/${encodeURIComponent(sourceId)}/schema`, undefined, "GET");
      assert.equal(schema.statusCode, 400);
      assert.match(schema.data.error, /remote_source module not found/);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane groups compatible GitHub source aliases under one host", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-host-stream-grouping-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });

      const repoEvents = await client.request<{ hostId: string; sourceId: string }>("/sources", {
        sourceType: "github_repo",
        sourceKey: "holon-run/agentinbox",
        config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
      });
      const ciRuns = await client.request<{ hostId: string; sourceId: string }>("/sources", {
        sourceType: "github_repo_ci",
        sourceKey: "holon-run/agentinbox",
        config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-default" },
      });

      assert.equal(repoEvents.statusCode, 200);
      assert.equal(ciRuns.statusCode, 200);
      assert.equal(repoEvents.data.hostId, ciRuns.data.hostId);

      const hosts = await client.request<{ hosts: Array<{ hostId: string; hostType: string }> }>("/hosts", undefined, "GET");
      assert.equal(hosts.statusCode, 200);
      assert.equal(hosts.data.hosts.filter((host) => host.hostType === "github").length, 1);

      const hostDetails = await client.request<{ host: { hostId: string; hostType: string }; streams: Array<{ sourceId: string; streamKind: string }> }>(
        `/hosts/${encodeURIComponent(repoEvents.data.hostId)}`,
        undefined,
        "GET",
      );
      assert.equal(hostDetails.statusCode, 200);
      assert.equal(hostDetails.data.host.hostType, "github");
      assert.deepEqual(
        hostDetails.data.streams.map((stream) => stream.streamKind).sort(),
        ["ci_runs", "repo_events"],
      );
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane creates streams under explicit hosts", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-host-stream-create-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const host = await client.request<{ hostId: string; hostType: string }>("/hosts", {
        hostType: "local_event",
        hostKey: "local-default",
        config: {},
      });
      assert.equal(host.statusCode, 200);

      const stream = await client.request<{ sourceId: string; hostId: string; streamKind: string }>(
        "/streams",
        {
          hostId: host.data.hostId,
          streamKind: "events",
          streamKey: "local-default",
          compatSourceType: "local_event",
          config: {},
        },
      );
      assert.equal(stream.statusCode, 200);
      assert.equal(stream.data.hostId, host.data.hostId);
      assert.equal(stream.data.streamKind, "events");

      const listed = await client.request<{ streams: Array<{ sourceId: string; hostId: string }> }>("/streams", undefined, "GET");
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.data.streams.some((candidate) => candidate.sourceId === stream.data.sourceId && candidate.hostId === host.data.hostId), true);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane allows the same GitHub stream key under different hosts", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-host-dups-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({ kind: "socket", socketPath, source: "flag" });
      const hostA = await client.request<{ hostId: string }>("/hosts", {
        hostType: "github",
        hostKey: "uxcAuth:github-a",
        config: { uxcAuth: "github-a" },
      });
      const hostB = await client.request<{ hostId: string }>("/hosts", {
        hostType: "github",
        hostKey: "uxcAuth:github-b",
        config: { uxcAuth: "github-b" },
      });

      assert.equal(hostA.statusCode, 200);
      assert.equal(hostB.statusCode, 200);
      assert.notEqual(hostA.data.hostId, hostB.data.hostId);

      const streamA = await client.request<{ sourceId: string; hostId: string; streamKind: string }>(
        "/streams",
        {
          hostId: hostA.data.hostId,
          streamKind: "repo_events",
          streamKey: "holon-run/agentinbox",
          config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-a" },
        },
      );
      const streamB = await client.request<{ sourceId: string; hostId: string; streamKind: string }>(
        "/streams",
        {
          hostId: hostB.data.hostId,
          streamKind: "repo_events",
          streamKey: "holon-run/agentinbox",
          config: { owner: "holon-run", repo: "agentinbox", uxcAuth: "github-b" },
        },
      );

      assert.equal(streamA.statusCode, 200);
      assert.equal(streamB.statusCode, 200);
      assert.notEqual(streamA.data.sourceId, streamB.data.sourceId);
      assert.equal(streamA.data.hostId, hostA.data.hostId);
      assert.equal(streamB.data.hostId, hostB.data.hostId);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane source remove accepts with_subscriptions for explicit cascade cleanup", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-control-plane-remove-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const source = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "local_event",
        sourceKey: "control-plane-remove-cascade",
        config: {},
      });
      const registered = await client.request<{ agent: { agentId: string } }>("/agents", {
        backend: "tmux",
        runtimeKind: "codex",
        runtimeSessionId: "control-plane-remove-cascade-thread",
        tmuxPaneId: "%320",
      });
      const subscription = await client.request<{ subscriptionId: string }>("/subscriptions", {
        agentId: registered.data.agent.agentId,
        sourceId: source.data.sourceId,
      });

      const removed = await client.request<{
        removed: boolean;
        sourceId: string;
        removedSubscriptions: number;
        pausedSource: boolean;
      }>(`/sources/${encodeURIComponent(source.data.sourceId)}?with_subscriptions=true`, undefined, "DELETE");

      assert.equal(removed.statusCode, 200);
      assert.equal(removed.data.removed, true);
      assert.equal(removed.data.sourceId, source.data.sourceId);
      assert.equal(removed.data.removedSubscriptions, 1);
      assert.equal(removed.data.pausedSource, false);

      const missingSubscription = await client.request(
        `/subscriptions/${encodeURIComponent(subscription.data.subscriptionId)}`,
        undefined,
        "GET",
      );
      assert.equal(missingSubscription.statusCode, 404);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("control plane source remove rejects invalid with_subscriptions query values", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aix-rm-invalid-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input), {
    homeDir,
    remoteSourceClient: new FakeRemoteSourceClient(),
  });
  service = new AgentInboxService(store, adapters, undefined, undefined, undefined, new TerminalDispatcher(async () => ({
    stdout: "",
    stderr: "",
  })));
  const server = createServer(service);

  try {
    const started = await startControlServer(server, {
      kind: "socket",
      socketPath,
    });
    try {
      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });
      const source = await client.request<{ sourceId: string }>("/sources", {
        sourceType: "local_event",
        sourceKey: "control-plane-remove-invalid",
        config: {},
      });

      const invalid = await client.request(
        `/sources/${encodeURIComponent(source.data.sourceId)}?with_subscriptions=yes`,
        undefined,
        "DELETE",
      );
      assert.equal(invalid.statusCode, 400);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
