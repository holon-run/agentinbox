import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters";
import { SqliteEventBusBackend } from "../src/backend";
import { Activation, ActivationTarget, AppendSourceEventInput, Subscription, TerminalActivationTarget } from "../src/model";
import { ActivationDispatcher, AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";
import { TerminalDispatcher } from "../src/terminal";

class RecordingActivationDispatcher extends ActivationDispatcher {
  public readonly calls: Array<{ targetUrl: string; activation: Activation }> = [];

  override async dispatch(targetUrl: string, activation: Activation): Promise<void> {
    this.calls.push({ targetUrl, activation });
  }
}

class RecordingTerminalDispatcher extends TerminalDispatcher {
  public readonly calls: Array<{ target: TerminalActivationTarget; prompt: string }> = [];

  override async dispatch(target: TerminalActivationTarget, prompt: string): Promise<void> {
    this.calls.push({ target, prompt });
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
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input));
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

test("shared source can route one stream event to multiple agent inboxes", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "1");
    const beta = await registerTmuxAgent(service, "2");
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const subscriptionA = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
    });
    const subscriptionB = await service.registerSubscription({
      agentId: beta.agentId,
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
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

test("custom source can act as a programmable event bus source", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "3");
    const source = await service.registerSource({
      sourceType: "custom",
      sourceKey: "project-alpha",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
      startPolicy: "earliest",
    });

    const appendResult = await service.appendSourceEventByCaller(source.sourceId, {
      sourceNativeId: "custom-evt-1",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: { text: "hello from custom source" },
    });
    assert.equal(appendResult.appended, 1);

    const pollResult = await service.pollSubscription(subscription.subscriptionId);
    const items = service.listInboxItems(alpha.agentId);
    assert.equal(pollResult.inboxItemsCreated, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceNativeId, "custom-evt-1");
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
      sourceType: "fixture",
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
      sourceType: "custom",
      sourceKey: "ack-through-demo",
      config: {},
    });
    const subscription = await service.registerSubscription({
      agentId: alpha.agentId,
      sourceId: source.sourceId,
      startPolicy: "earliest",
    });

    for (const id of ["evt-1", "evt-2", "evt-3"]) {
      await service.appendSourceEventByCaller(source.sourceId, {
        sourceNativeId: id,
        eventVariant: "message.created",
        metadata: {},
        rawPayload: { text: id },
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
      sourceType: "custom",
      sourceKey: "custom-gated",
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
