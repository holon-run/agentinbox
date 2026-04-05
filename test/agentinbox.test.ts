import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { AgentInboxStore } from "../src/store";
import { ActivationDispatcher, AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { SqliteEventBusBackend } from "../src/backend";
import { Activation } from "../src/model";

class RecordingActivationDispatcher extends ActivationDispatcher {
  public readonly calls: Array<{ target: string | null | undefined; activation: Activation }> = [];

  override async dispatch(target: string | null | undefined, activation: Activation): Promise<void> {
    this.calls.push({ target, activation });
  }
}

async function makeAsyncService(options?: {
  dispatcher?: ActivationDispatcher;
  activationWindowMs?: number;
  activationMaxItems?: number;
}): Promise<{ store: AgentInboxStore; service: AgentInboxService; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input) => service.appendSourceEvent(input));
  service = new AgentInboxService(
    store,
    adapters,
    options?.dispatcher,
    undefined,
    {
      windowMs: options?.activationWindowMs,
      maxItems: options?.activationMaxItems,
    },
  );
  return { store, service, dir };
}

test("shared source can route one stream event to multiple agent inboxes", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const subscriptionA = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
    });
    const subscriptionB = await service.registerSubscription({
      agentId: "beta",
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
    });

    const appendResult = await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: { text: "hello" },
    });
    assert.equal(appendResult.appended, 1);

    const pollA = await service.pollSubscription(subscriptionA.subscriptionId);
    const pollB = await service.pollSubscription(subscriptionB.subscriptionId);

    assert.equal(pollA.inboxItemsCreated, 1);
    assert.equal(pollB.inboxItemsCreated, 1);
    assert.equal(service.listInboxItems(subscriptionA.inboxId).length, 1);
    assert.equal(service.listInboxItems(subscriptionB.inboxId).length, 1);
    await service.stop();
    assert.equal(store.listActivations().length, 2);
    assert.equal(store.listSources().length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stream dedupe and consumer offsets prevent duplicate inbox inserts", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: {},
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    const second = await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    assert.equal(second.appended, 0);
    assert.equal(second.deduped, 1);

    const firstPoll = await service.pollSubscription(subscription.subscriptionId);
    const secondPoll = await service.pollSubscription(subscription.subscriptionId);

    assert.equal(firstPoll.inboxItemsCreated, 1);
    assert.equal(secondPoll.inboxItemsCreated, 0);
    assert.equal(service.listInboxItems(subscription.inboxId).length, 1);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite event bus keeps independent offsets per subscription", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const early = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });

    const latest = await service.registerSubscription({
      agentId: "beta",
      sourceId: source.sourceId,
      startPolicy: "latest",
    });

    const pollEarly = await service.pollSubscription(early.subscriptionId);
    const pollLatest = await service.pollSubscription(latest.subscriptionId);

    assert.equal(pollEarly.inboxItemsCreated, 1);
    assert.equal(pollLatest.inboxItemsCreated, 0);

    const backend = new SqliteEventBusBackend(store);
    const earlyLag = await backend.getConsumerLag({ subscriptionId: early.subscriptionId });
    const latestLag = await backend.getConsumerLag({ subscriptionId: latest.subscriptionId });
    assert.equal(earlyLag.pendingEvents, 0);
    assert.equal(latestLag.pendingEvents, 0);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delivery requests are recorded with provider metadata", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const result = await service.sendDelivery({
      provider: "fixture",
      surface: "chat",
      targetRef: "room-1",
      kind: "reply",
      payload: { text: "hello" },
    });
    assert.equal(result.status, "accepted");
    assert.equal(store.listDeliveries().length, 1);
    assert.equal(store.listDeliveries()[0].targetRef, "room-1");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy interest/mailbox schema migrates to subscriptions/inboxes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-migrate-test-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
  });
  const legacy = new SQL.Database();
  legacy.exec(`
    create table sources (
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
    create table interests (
      interest_id text primary key,
      agent_id text not null,
      source_id text not null,
      mailbox_id text not null,
      match_rules_json text not null,
      activation_target text,
      created_at text not null
    );
    create table inbox_items (
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
    create table activations (
      activation_id text primary key,
      agent_id text not null,
      mailbox_id text not null,
      new_item_count integer not null,
      summary text not null,
      created_at text not null,
      delivered_at text
    );
    create table deliveries (
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
  legacy.run(
    `
    insert into sources (
      source_id, source_type, source_key, config_ref, config_json, status, checkpoint, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ["src_legacy", "fixture", "demo", null, "{}", "active", null, "2026-04-05T00:00:00.000Z", "2026-04-05T00:00:00.000Z"],
  );
  legacy.run(
    `
    insert into interests (
      interest_id, agent_id, source_id, mailbox_id, match_rules_json, activation_target, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `,
    ["int_legacy", "alpha", "src_legacy", "mbx_alpha", "{}", null, "2026-04-05T00:00:00.000Z"],
  );
  legacy.run(
    `
    insert into inbox_items (
      item_id, source_id, source_native_id, event_variant, mailbox_id, occurred_at,
      metadata_json, raw_payload_json, delivery_handle_json, acked_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ["item_legacy", "src_legacy", "evt-1", "message.created", "mbx_alpha", "2026-04-05T00:00:00.000Z", "{}", "{}", null, null],
  );
  legacy.run(
    `
    insert into activations (
      activation_id, agent_id, mailbox_id, new_item_count, summary, created_at, delivered_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `,
    ["act_legacy", "alpha", "mbx_alpha", 1, "fixture:demo:message.created", "2026-04-05T00:00:00.000Z", null],
  );
  fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
  legacy.close();

  const store = await AgentInboxStore.open(dbPath);
  try {
    const subscriptions = store.listSubscriptions();
    const inboxes = store.listInboxes();
    const inboxItems = store.listInboxItems("mbx_alpha");
    const activations = store.listActivations();
    const streams = store.listStreams();
    const consumers = store.listConsumers();

    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].subscriptionId, "int_legacy");
    assert.equal(subscriptions[0].inboxId, "mbx_alpha");
    assert.equal(inboxes.length, 1);
    assert.equal(inboxes[0].inboxId, "mbx_alpha");
    assert.equal(inboxItems.length, 1);
    assert.equal(activations.length, 1);
    assert.equal(activations[0].inboxId, "mbx_alpha");
    assert.equal(streams.length, 1);
    assert.equal(consumers.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("activations are aggregated within the inbox window", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const { store, service, dir } = await makeAsyncService({
    dispatcher,
    activationWindowMs: 40,
    activationMaxItems: 20,
  });
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: {},
      activationTarget: "http://louke.local/activate?agent=alpha",
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });

    const poll = await service.pollSubscription(subscription.subscriptionId);
    assert.equal(poll.inboxItemsCreated, 2);
    assert.equal(dispatcher.calls.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(dispatcher.calls.length, 1);
    const activation = dispatcher.calls[0].activation;
    assert.equal(activation.kind, "agentinbox.activation");
    assert.equal(activation.agentId, "alpha");
    assert.equal(activation.inboxId, "inbox_alpha");
    assert.deepEqual(activation.subscriptionIds, [subscription.subscriptionId]);
    assert.deepEqual(activation.sourceIds, [source.sourceId]);
    assert.equal(activation.newItemCount, 2);
    assert.match(activation.summary, /2 new items in inbox_alpha/);
    assert.equal(store.listActivations().length, 1);
    assert.equal(store.listActivations()[0].newItemCount, 2);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("activations flush immediately when the inbox count threshold is reached", async () => {
  const dispatcher = new RecordingActivationDispatcher();
  const { store, service, dir } = await makeAsyncService({
    dispatcher,
    activationWindowMs: 500,
    activationMaxItems: 2,
  });
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: {},
      activationTarget: "http://louke.local/activate?agent=alpha",
      startPolicy: "earliest",
    });

    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    await service.appendSourceEvent({
      sourceId: source.sourceId,
      sourceNativeId: "evt-2",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });

    const poll = await service.pollSubscription(subscription.subscriptionId);
    assert.equal(poll.inboxItemsCreated, 2);

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(dispatcher.calls.length, 1);
    assert.equal(dispatcher.calls[0].activation.newItemCount, 2);
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
