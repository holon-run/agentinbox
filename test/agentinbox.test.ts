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
      filter: { metadata: { channel: "engineering" } },
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

test("subscription filter expr can match nested payload fields and exclude self-authored events", async () => {
  const { store, service, dir } = await makeService();
  try {
    const alpha = await registerTmuxAgent(service, "expr");
    const source = await service.registerSource({
      sourceType: "custom",
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
      sourceType: "custom",
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
      sourceType: "custom",
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
      sourceType: "custom",
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
