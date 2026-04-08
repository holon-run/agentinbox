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
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";

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
      timeout: 15_000,
    });
    assert.equal(status.status, 0, status.stderr);
    const parsedStatus = JSON.parse(status.stdout) as { counts?: { agents?: number } };
    assert.equal(typeof parsedStatus.counts?.agents, "number");

    const daemonState = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "status"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(daemonState.status, 0, daemonState.stderr);
    const parsedDaemon = JSON.parse(daemonState.stdout) as { running: boolean; pid: number | null };
    assert.equal(parsedDaemon.running, true);
    assert.ok(parsedDaemon.pid && parsedDaemon.pid > 0);

    const stopped = spawnSync("node", ["-r", "ts-node/register", "src/cli.ts", "daemon", "stop"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
      timeout: 15_000,
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
      }>("/agents/register", {
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

      const sourceResponse = await client.request<{ sourceId: string }>("/sources/register", {
        sourceType: "fixture",
        sourceKey: "e2e-demo",
        config: {},
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const subscriptionResponse = await client.request<{ subscriptionId: string }>("/subscriptions/register", {
        agentId,
        sourceId: sourceResponse.data.sourceId,
        matchRules: { channel: "engineering" },
        startPolicy: "earliest",
      });
      assert.equal(subscriptionResponse.statusCode, 200);

      const appendResponse = await client.request<{ appended: number }>("/fixtures/emit", {
        sourceId: sourceResponse.data.sourceId,
        sourceNativeId: "evt-e2e-1",
        eventVariant: "message.created",
        occurredAt: "2026-04-05T00:00:00Z",
        metadata: { channel: "engineering", subject: "hello" },
        rawPayload: { text: "hello from fixture" },
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
        `/agents/${encodeURIComponent(agentId)}/inbox/ack-all`,
        {},
      );
      assert.equal(ackResponse.statusCode, 200);
      assert.equal(ackResponse.data.acked, 1);

    } finally {
      await started.close();
    }
  } finally {
    webhookServer.close();
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
