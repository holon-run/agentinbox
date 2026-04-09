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
  async sourceEnsure(args: { namespace: string; sourceKey: string }): Promise<{ namespace: string; source_key: string; stream_id: string; status: string }> {
    return {
      namespace: args.namespace,
      source_key: args.sourceKey,
      stream_id: `stream:${args.sourceKey}`,
      status: "running",
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
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli auto-starts the daemon for normal commands and daemon stop shuts it down", () => {
  const repoDir = path.resolve(__dirname, "..");
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
    const parsedDaemon = JSON.parse(daemonState.stdout) as { running: boolean; pid: number | null };
    assert.equal(parsedDaemon.running, true);
    assert.ok(parsedDaemon.pid && parsedDaemon.pid > 0);

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

      const subscriptionResponse = await client.request<{ subscriptionId: string }>("/subscriptions", {
        agentId,
        sourceId: sourceResponse.data.sourceId,
        filter: { metadata: { channel: "engineering" } },
        startPolicy: "earliest",
      });
      assert.equal(subscriptionResponse.statusCode, 200);

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

      const inboxResponse = await client.request<{ items: InboxItem[] }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/items`,
        undefined,
        "GET",
      );
      assert.equal(inboxResponse.statusCode, 200);
      assert.equal(inboxResponse.data.items.length, 1);

      const ackResponse = await client.request<{ acked: number }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/ack`,
        { throughItemId: inboxResponse.data.items[0].itemId },
      );
      assert.equal(ackResponse.statusCode, 200);
      assert.equal(ackResponse.data.acked, 1);

      const unreadAfterAck = await client.request<{ items: InboxItem[] }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/items`,
        undefined,
        "GET",
      );
      assert.equal(unreadAfterAck.statusCode, 200);
      assert.equal(unreadAfterAck.data.items.length, 0);

      const historyAfterAck = await client.request<{ items: InboxItem[] }>(
        `/agents/${encodeURIComponent(agentId)}/inbox/items?include_acked=true`,
        undefined,
        "GET",
      );
      assert.equal(historyAfterAck.statusCode, 200);
      assert.equal(historyAfterAck.data.items.length, 1);

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

      const invalidLifecycleResponse = await client.request<{ error: string }>("/subscriptions", {
        agentId,
        sourceId: sourceResponse.data.sourceId,
        lifecycleMode: "ephemeral",
      });
      assert.equal(invalidLifecycleResponse.statusCode, 400);
      assert.match(invalidLifecycleResponse.data.error, /unsupported lifecycle mode/);

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
        `/agents/${encodeURIComponent(agentId)}/inbox/items?include_acked=true`,
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
      const response = await client.request<{ error: string }>("/sources", {
        sourceType: "remote_source",
        sourceKey: "remote-demo",
        config: {
          profilePath: "demo.mjs",
          profileConfig: {},
        },
      });
      assert.equal(response.statusCode, 200);
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
