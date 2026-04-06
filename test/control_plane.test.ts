import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { createServer } from "../src/http";
import { AgentInboxClient } from "../src/client";
import { startControlServer } from "../src/control_server";
import { DEFAULT_AGENTINBOX_PORT, resolveClientTransport, resolveServeConfig } from "../src/paths";
import { Activation, InboxItem, RegisterSourceInput, RegisterSubscriptionInput, SubscriptionPollResult, SubscriptionSource } from "../src/model";
import { nowIso } from "../src/util";

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

test("unix socket control plane replaces stale socket files and serves requests", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-socket-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");
  fs.writeFileSync(socketPath, "stale");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
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

test("e2e control plane can register fixture source, consume a subscription, and send aggregated activation webhook", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-e2e-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(
    store,
    adapters,
    undefined,
    undefined,
    {
      windowMs: 40,
      maxItems: 20,
    },
  );
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
      const activationTarget = `http://127.0.0.1:${address.port}/louke/activate`;

      const client = new AgentInboxClient({
        kind: "socket",
        socketPath,
        source: "flag",
      });

      const sourceResponse = await client.request<{
        sourceId: string;
        sourceType: string;
      }>("/sources/register", {
        sourceType: "fixture",
        sourceKey: "e2e-demo",
        config: {},
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const subscriptionResponse = await client.request<{
        subscriptionId: string;
        inboxId: string;
        agentId: string;
      }>("/subscriptions/register", {
        agentId: "alpha",
        sourceId: sourceResponse.data.sourceId,
        matchRules: { channel: "engineering" },
        activationTarget,
        startPolicy: "earliest",
      } satisfies RegisterSubscriptionInput);
      assert.equal(subscriptionResponse.statusCode, 200);

      const appendResponse = await client.request<{
        appended: number;
        deduped: number;
      }>("/fixtures/emit", {
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
      assert.equal(activation.kind, "agentinbox.activation");
      assert.equal(activation.agentId, "alpha");
      assert.equal(activation.inboxId, subscriptionResponse.data.inboxId);
      assert.deepEqual(activation.subscriptionIds, [subscriptionResponse.data.subscriptionId]);
      assert.deepEqual(activation.sourceIds, [sourceResponse.data.sourceId]);
      assert.equal(activation.newItemCount, 1);
      assert.equal(activation.items, undefined);
      assert.match(activation.summary, /1 new item/);

      const inboxResponse = await client.request<{ items: InboxItem[] }>(
        `/inboxes/${subscriptionResponse.data.inboxId}/items`,
        undefined,
        "GET",
      );
      assert.equal(inboxResponse.statusCode, 200);
      assert.equal(inboxResponse.data.items.length, 1);
      assert.equal(inboxResponse.data.items[0].sourceNativeId, "evt-e2e-1");
      assert.equal(inboxResponse.data.items[0].metadata.channel, "engineering");
    } finally {
      webhookServer.closeAllConnections?.();
      await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("e2e control plane can append events through a custom source", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-custom-source-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
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

      const sourceResponse = await client.request<{ sourceId: string; sourceType: string }>("/sources/register", {
        sourceType: "custom",
        sourceKey: "project-alpha",
        config: {},
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);
      assert.equal(sourceResponse.data.sourceType, "custom");

      const subscriptionResponse = await client.request<{ subscriptionId: string; inboxId: string }>(
        "/subscriptions/register",
        {
          agentId: "alpha",
          sourceId: sourceResponse.data.sourceId,
          matchRules: { channel: "engineering" },
          startPolicy: "earliest",
        } satisfies RegisterSubscriptionInput,
      );
      assert.equal(subscriptionResponse.statusCode, 200);

      const appendResponse = await client.request<{ appended: number; deduped: number }>(
        `/sources/${encodeURIComponent(sourceResponse.data.sourceId)}/events`,
        {
          sourceNativeId: "custom-evt-1",
          eventVariant: "message.created",
          metadata: { channel: "engineering" },
          rawPayload: { text: "hello from custom source" },
        },
      );
      assert.equal(appendResponse.statusCode, 200);
      assert.equal(appendResponse.data.appended, 1);

      const pollResponse = await client.request<SubscriptionPollResult>(
        `/subscriptions/${subscriptionResponse.data.subscriptionId}/poll`,
        {},
      );
      assert.equal(pollResponse.statusCode, 200);
      assert.equal(pollResponse.data.inboxItemsCreated, 1);

      const inboxResponse = await client.request<{ items: InboxItem[] }>(
        `/inboxes/${subscriptionResponse.data.inboxId}/items`,
        undefined,
        "GET",
      );
      assert.equal(inboxResponse.statusCode, 200);
      assert.equal(inboxResponse.data.items.length, 1);
      assert.equal(inboxResponse.data.items[0].sourceNativeId, "custom-evt-1");
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("e2e control plane watch streams backlog and future inbox items over socket SSE", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-watch-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
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

      const sourceResponse = await client.request<{ sourceId: string }>("/sources/register", {
        sourceType: "fixture",
        sourceKey: "watch-demo",
        config: {},
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const subscriptionResponse = await client.request<{ subscriptionId: string; inboxId: string }>(
        "/subscriptions/register",
        {
          agentId: "alpha",
          sourceId: sourceResponse.data.sourceId,
          startPolicy: "earliest",
        } satisfies RegisterSubscriptionInput,
      );
      assert.equal(subscriptionResponse.statusCode, 200);

      await client.request("/fixtures/emit", {
        sourceId: sourceResponse.data.sourceId,
        sourceNativeId: "evt-watch-1",
        eventVariant: "message.created",
        metadata: { channel: "engineering" },
        rawPayload: { text: "first" },
      });
      await client.request<SubscriptionPollResult>(
        `/subscriptions/${subscriptionResponse.data.subscriptionId}/poll`,
        {},
      );

      const watch = client.watchInbox(subscriptionResponse.data.inboxId, {
        heartbeatMs: 25,
      })[Symbol.asyncIterator]();

      const firstEvent = await waitForWatchItems(watch, 1_000, "timed out waiting for backlog watch event");
      assert.equal(firstEvent.items.length, 1);
      assert.equal(firstEvent.items[0].sourceNativeId, "evt-watch-1");
      assert.equal(firstEvent.items[0].ackedAt, null);

      await client.request("/fixtures/emit", {
        sourceId: sourceResponse.data.sourceId,
        sourceNativeId: "evt-watch-2",
        eventVariant: "message.created",
        metadata: { channel: "engineering" },
        rawPayload: { text: "second" },
      });
      await client.request<SubscriptionPollResult>(
        `/subscriptions/${subscriptionResponse.data.subscriptionId}/poll`,
        {},
      );

      const secondEvent = await waitForWatchItems(watch, 1_000, "timed out waiting for future watch event");
      assert.equal(secondEvent.items.length, 1);
      assert.equal(secondEvent.items[0].sourceNativeId, "evt-watch-2");

      await watch.return?.();
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("inbox reads return 404 when after_item_id is unknown", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-watch-invalid-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
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
      const sourceResponse = await client.request<{ sourceId: string }>("/sources/register", {
        sourceType: "fixture",
        sourceKey: "watch-invalid",
        config: {},
      } satisfies RegisterSourceInput);
      const subscriptionResponse = await client.request<{ inboxId: string }>("/subscriptions/register", {
        agentId: "alpha",
        sourceId: sourceResponse.data.sourceId,
      } satisfies RegisterSubscriptionInput);
      const response = await client.request<{ error: string }>(
        `/inboxes/${encodeURIComponent(subscriptionResponse.data.inboxId)}/items?after_item_id=missing`,
        undefined,
        "GET",
      );
      assert.equal(response.statusCode, 404);
      assert.match(response.data.error, /unknown inbox item/);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("manual append endpoint rejects adapter-managed sources", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-manual-append-home-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  const githubSource: SubscriptionSource = {
    sourceId: "src_github_manual_append",
    sourceType: "github_repo",
    sourceKey: "holon-run/agentinbox",
    configRef: null,
    config: { owner: "holon-run", repo: "agentinbox" },
    status: "active",
    checkpoint: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.insertSource(githubSource);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
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
      const response = await client.request<{ error: string }>(
        `/sources/${encodeURIComponent(githubSource.sourceId)}/events`,
        {
          sourceNativeId: "evt-1",
          eventVariant: "message.created",
          metadata: {},
          rawPayload: {},
        },
      );
      assert.equal(response.statusCode, 400);
      assert.match(response.data.error, /manual append is not supported for source type: github_repo/);
    } finally {
      await started.close();
    }
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("sources/events validates string ids and delivery handle shape", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aix-sev-"));
  const socketPath = path.join(homeDir, "agentinbox.sock");
  const dbPath = path.join(homeDir, "agentinbox.sqlite");

  const store = await AgentInboxStore.open(dbPath);
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
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
      const sourceResponse = await client.request<SubscriptionSource>("/sources/register", {
        sourceType: "custom",
        sourceKey: "validate-demo",
      } satisfies RegisterSourceInput);
      assert.equal(sourceResponse.statusCode, 200);

      const invalidId = await client.request<{ error: string }>(`/sources/${sourceResponse.data.sourceId}/events`, {
        sourceNativeId: { bad: true },
        eventVariant: "message.created",
      });
      assert.equal(invalidId.statusCode, 400);
      assert.match(invalidId.data.error, /sources\/events requires sourceNativeId/);

      const invalidDeliveryHandle = await client.request<{ error: string }>(`/sources/${sourceResponse.data.sourceId}/events`, {
        sourceNativeId: "evt-1",
        eventVariant: "message.created",
        deliveryHandle: { provider: "github" },
      });
      assert.equal(invalidDeliveryHandle.statusCode, 400);
      assert.match(invalidDeliveryHandle.data.error, /deliveryHandle requires provider, surface, and targetRef/);
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
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForWatchItems(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number,
  message: string,
): Promise<{ event: "items"; inboxId: string; items: InboxItem[] }> {
  while (true) {
    const next = await waitFor(iterator.next(), timeoutMs, message);
    assert.equal(next.done, false);
    const value = next.value as { event: string; inboxId: string; items?: InboxItem[] };
    if (value.event === "items") {
      return value as { event: "items"; inboxId: string; items: InboxItem[] };
    }
  }
}
