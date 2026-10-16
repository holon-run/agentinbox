import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AdapterRegistry } from "../src/adapters";
import { Activation, AppendSourceEventInput } from "../src/model";
import { ActivationDispatcher, AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const entryIds = (activation: Activation) => activation.entries!.map((entry) => entry.entryId).sort();
const targetKey = (activation: Activation) => `${activation.agentId}::${activation.targetId}`;

class Webhooks extends ActivationDispatcher {
  readonly calls: Activation[] = [];
  readonly active = new Map<string, number>();
  readonly maxActive = new Map<string, number>();
  totalActive = 0;
  maxTotalActive = 0;
  onDispatch?: (activation: Activation) => Promise<void>;

  override async dispatch(_url: string, activation: Activation): Promise<void> {
    const key = targetKey(activation);
    const active = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, active);
    this.maxActive.set(key, Math.max(this.maxActive.get(key) ?? 0, active));
    this.maxTotalActive = Math.max(this.maxTotalActive, ++this.totalActive);
    this.calls.push(activation);
    try {
      await this.onDispatch?.(activation);
    } finally {
      this.active.set(key, this.active.get(key)! - 1);
      this.totalActive--;
    }
  }

  hold() {
    const started = deferred();
    const release = deferred();
    let first = true;
    this.onDispatch = async () => {
      if (!first) return;
      first = false;
      started.resolve();
      await release.promise;
    };
    return { started: started.promise, release: release.resolve };
  }

  assertSingleFlight() {
    assert.deepEqual([...this.maxActive.values()], [...this.maxActive.values()].map(() => 1),
      `same-target overlap: ${JSON.stringify({
        maxActive: [...this.maxActive],
        batches: this.calls.map((call) => ({ target: targetKey(call), entryIds: entryIds(call) })),
      })}`);
    assert.equal(this.totalActive, 0);
  }
}

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-single-flight-"));
  const store = await AgentInboxStore.open(path.join(dir, "inbox.sqlite"));
  const webhooks = new Webhooks();
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store,
    (input: AppendSourceEventInput) => service.appendSourceEvent(input), { homeDir: dir });
  // No service.start(): tests drive real flush/tick paths, without background timers.
  service = new AgentInboxService(store, adapters, webhooks, undefined, { windowMs: 60_000 });
  const internals = service as unknown as {
    flushNotificationBuffer(key: string): Promise<void>;
    syncActivationDispatchStates(): Promise<void>;
  };
  const register = (agentId = "single-flight-agent") => {
    const { webhookTarget } = service.registerAgent({
      agentId, runtimeKind: "holon",
      webhook: { url: "http://127.0.0.1:1/unused", activationMode: "activation_with_items" },
    });
    return { agentId, targetId: webhookTarget!.targetId };
  };
  const add = async (agentId: string, message: string) => {
    const before = new Set(service.listInboxItems(agentId).map((entry) => entry.entryId));
    await service.addDirectInboxTextMessage(agentId, { message });
    const added = service.listInboxItems(agentId).filter((entry) => !before.has(entry.entryId));
    assert.equal(added.length, 1);
    return added[0].entryId;
  };
  const flush = (target: { agentId: string; targetId: string }) =>
    internals.flushNotificationBuffer(`${target.agentId}::${target.targetId}`);
  const expire = (target: { agentId: string; targetId: string }) => {
    const state = store.getActivationDispatchState(target.agentId, target.targetId);
    assert.ok(state);
    store.upsertActivationDispatchState({ ...state, leaseExpiresAt: new Date(0).toISOString() });
  };
  const sync = () => internals.syncActivationDispatchStates();
  const dirty = async () => {
    const target = register();
    const first = await add(target.agentId, "already notified");
    await flush(target);
    const second = await add(target.agentId, "new pending entry");
    await flush(target);
    assert.equal(store.getActivationDispatchState(target.agentId, target.targetId)!.status, "dirty");
    expire(target);
    return { ...target, firstId: first, ids: [first, second].sort() };
  };
  const cleanup = async () => {
    t.diagnostic(JSON.stringify({
      maxActive: [...webhooks.maxActive],
      maxTotalActive: webhooks.maxTotalActive,
      batches: webhooks.calls.map((call) => ({ target: targetKey(call), entryIds: entryIds(call) })),
    }));
    webhooks.onDispatch = undefined;
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, service, webhooks, register, add, flush, expire, sync, dirty, cleanup };
}

test("dirty webhook lease ticks serialize successful slow delivery and recheck the renewed lease",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    try {
      const target = await fx.dirty();
      const delivery = fx.webhooks.hold();
      try {
        const first = fx.sync();
        await delivery.started;
        const queued = [fx.sync(), fx.sync(), fx.sync()];
        // Let runnable contenders reach dispatch on the old implementation.
        await setImmediate();
        delivery.release();
        await Promise.all([first, ...queued]);
        fx.webhooks.assertSingleFlight();
        assert.deepEqual(fx.webhooks.calls.map(entryIds), [[target.firstId], target.ids]);
        assert.equal(fx.store.getActivationDispatchState(target.agentId, target.targetId)!.status, "notified");
        fx.expire(target);
        await fx.sync();
        assert.equal(fx.webhooks.calls.length, 2, "unchanged notified backlog only renews its lease");
      } finally { delivery.release(); }
    } finally { await fx.cleanup(); }
  });

for (const ackAll of [false, true]) {
  test(`in-flight lease with ${ackAll ? "full" : "partial"} ack preserves the complete new batch`,
    { timeout: 10_000 }, async (t) => {
      const fx = await fixture(t);
      let release = () => {};
      try {
        const target = await fx.dirty();
        const hold = fx.webhooks.hold();
        release = hold.release;
        const first = fx.sync();
        await hold.started;
        const added = await fx.add(target.agentId, "arrived during webhook");
        const buffered = fx.flush(target);
        const acked = ackAll ? target.ids : [target.ids[0]];
        // This must complete before the receiver releases its response.
        await fx.service.ackInboxItems(target.agentId, acked);
        const queued = fx.sync();
        await setImmediate();
        hold.release();
        await Promise.all([first, buffered, queued]);
        const remaining = [...target.ids.filter((id) => !acked.includes(id)), added].sort();
        fx.webhooks.assertSingleFlight();
        assert.deepEqual(fx.webhooks.calls.slice(1).map(entryIds), [target.ids, remaining]);
        assert.deepEqual(fx.service.listInboxItems(target.agentId).map((entry) => entry.entryId).sort(), remaining);
        assert.equal(fx.service.listInboxItems(target.agentId, { includeAcked: true })
          .filter((entry) => entry.ackedAt != null).length, acked.length);
      } finally { release(); await fx.cleanup(); }
    });
}

test("buffer flush queued behind lease retains entries added during the slow response",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    let release = () => {};
    try {
      const target = await fx.dirty();
      const hold = fx.webhooks.hold();
      release = hold.release;
      const first = fx.sync();
      await hold.started;
      const added = await fx.add(target.agentId, "buffered during lease");
      const buffered = fx.flush(target);
      const queued = fx.sync();
      await setImmediate();
      hold.release();
      await Promise.all([first, buffered, queued]);
      assert.equal(fx.webhooks.calls.length, 2, "active-lease merge is not another notification");
      const state = fx.store.getActivationDispatchState(target.agentId, target.targetId)!;
      assert.equal(state.status, "dirty");
      assert.equal(state.pendingNewItemCount, 1);
      fx.expire(target);
      await fx.sync();
      fx.webhooks.assertSingleFlight();
      assert.deepEqual(fx.webhooks.calls.slice(1).map(entryIds),
        [target.ids, [...target.ids, added].sort()]);
    } finally { release(); await fx.cleanup(); }
  });

test("webhook receiver can ack its complete batch before returning with lease ticks queued",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    const started = deferred();
    const release = deferred();
    try {
      const target = await fx.dirty();
      fx.webhooks.onDispatch = async (activation) => {
        await fx.service.ackInboxItems(target.agentId, entryIds(activation));
        started.resolve();
        await release.promise;
      };
      const first = fx.sync();
      await started.promise;
      const queued = [fx.sync(), fx.sync()];
      release.resolve();
      await Promise.all([first, ...queued]);
      fx.webhooks.assertSingleFlight();
      assert.deepEqual(fx.webhooks.calls.slice(1).map(entryIds), [target.ids]);
      assert.deepEqual(fx.service.listInboxItems(target.agentId), []);
      assert.equal(fx.store.getActivationDispatchState(target.agentId, target.targetId), null);
    } finally { release.resolve(); await fx.cleanup(); }
  });

test("failed slow webhook makes queued lease ticks obey fresh backoff and remains retryable",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    const started = deferred();
    const release = deferred();
    try {
      const target = await fx.dirty();
      fx.webhooks.onDispatch = async () => {
        started.resolve();
        await release.promise;
        throw Object.assign(new Error("fixture transient failure"), { statusCode: 500 });
      };
      const first = fx.sync();
      await started.promise;
      const queued = [fx.sync(), fx.sync()];
      await setImmediate();
      release.resolve();
      await Promise.all([first, ...queued]);
      fx.webhooks.assertSingleFlight();
      assert.deepEqual(fx.webhooks.calls.slice(1).map(entryIds), [target.ids]);
      const state = fx.store.getActivationDispatchState(target.agentId, target.targetId)!;
      assert.equal(state.status, "dirty");
      assert.ok(Date.parse(state.leaseExpiresAt!) > Date.now());
      assert.equal(fx.service.getActivationTarget(target.targetId).consecutiveFailures, 1);
      await fx.sync();
      assert.equal(fx.webhooks.calls.length, 2);
      fx.webhooks.onDispatch = undefined;
      fx.expire(target);
      await fx.sync();
      assert.deepEqual(fx.webhooks.calls.slice(1).map(entryIds), [target.ids, target.ids]);
      fx.webhooks.assertSingleFlight();
      assert.equal(fx.store.getActivationDispatchState(target.agentId, target.targetId)!.status, "notified");
      assert.equal(fx.service.getActivationTarget(target.targetId).consecutiveFailures, 0);
    } finally { release.resolve(); await fx.cleanup(); }
  });

test("two agents and two targets deliver independently while one target is blocked",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    let release = () => {};
    try {
      const first = fx.register("first-agent");
      const other = fx.register("other-agent");
      const second = fx.service.addWebhookActivationTarget(first.agentId, {
        url: "http://127.0.0.1:2/unused", activationMode: "activation_with_items",
      });
      const firstId = await fx.add(first.agentId, "first agent backlog");
      const otherId = await fx.add(other.agentId, "other agent backlog");
      const hold = fx.webhooks.hold();
      release = hold.release;
      const blocked = fx.flush(first);
      await hold.started;
      // Separate dispatch initiators: a single sync deliberately iterates sequentially.
      await Promise.all([fx.flush(second), fx.flush(other)]);
      assert.equal(fx.webhooks.totalActive, 1, "other targets complete while the first stays blocked");
      assert.ok(fx.webhooks.maxTotalActive >= 2, "the delivery lock must not be global");
      hold.release();
      await blocked;
      fx.webhooks.assertSingleFlight();
      assert.deepEqual(fx.webhooks.calls.map((call) => [call.targetId, entryIds(call)]).sort(),
        [[first.targetId, [firstId]], [second.targetId, [firstId]], [other.targetId, [otherId]]].sort());
    } finally { release(); await fx.cleanup(); }
  });

test("deleted in-flight target cannot revive state or clobber its replacement",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    let release = () => {};
    try {
      const old = await fx.dirty();
      const hold = fx.webhooks.hold();
      release = hold.release;
      const first = fx.sync();
      await hold.started;
      const queued = fx.sync();
      fx.service.removeActivationTarget(old.agentId, old.targetId);
      const replacement = fx.service.addWebhookActivationTarget(old.agentId, {
        url: "http://127.0.0.1:3/unused", activationMode: "activation_with_items",
      });
      const added = await fx.add(old.agentId, "new target backlog");
      await fx.flush(replacement);
      hold.release();
      await Promise.all([first, queued]);
      fx.webhooks.assertSingleFlight();
      assert.equal(fx.store.getActivationTarget(old.targetId), null);
      assert.equal(fx.store.getActivationDispatchState(old.agentId, old.targetId), null);
      assert.equal(fx.store.getActivationDispatchState(old.agentId, replacement.targetId)!.status, "notified");
      assert.deepEqual(fx.webhooks.calls.slice(1).map((call) => [call.targetId, entryIds(call)]),
        [[old.targetId, old.ids], [replacement.targetId, [...old.ids, added].sort()]]);
      fx.expire(replacement);
      await fx.sync();
      assert.equal(fx.webhooks.calls.length, 3);
    } finally { release(); await fx.cleanup(); }
  });

test("pause fences queued lease ticks and concurrent resumes notify the complete catch-up batch",
  { timeout: 10_000 }, async (t) => {
    const fx = await fixture(t);
    let release = () => {};
    try {
      const target = await fx.dirty();
      const hold = fx.webhooks.hold();
      release = hold.release;
      const first = fx.sync();
      await hold.started;
      const queued = fx.sync();
      fx.service.pauseAgent(target.agentId);
      const added = await fx.add(target.agentId, "paused catch-up entry");
      const resumes = [
        fx.service.resumeAgent(target.agentId, { deliveryOnly: true }),
        fx.service.resumeAgent(target.agentId, { deliveryOnly: true }),
      ];
      hold.release();
      await Promise.all([first, queued, ...resumes]);
      fx.webhooks.assertSingleFlight();
      assert.deepEqual(fx.webhooks.calls.slice(1).map(entryIds),
        [target.ids, [...target.ids, added].sort()]);
      assert.equal(fx.service.getAgent(target.agentId).deliveryPaused, false);
    } finally { release(); await fx.cleanup(); }
  });
