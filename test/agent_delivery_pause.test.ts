import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import { AdapterRegistry } from "../src/adapters";
import { Activation, AppendSourceEventInput, TerminalActivationTarget } from "../src/model";
import { AgentInboxService, ActivationDispatcher } from "../src/service";
import { AgentInboxStore } from "../src/store";
import { ActivationGate } from "../src/runtime_gate";
import { TerminalDispatcher } from "../src/terminal";
import { createServer } from "../src/http";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail("condition did not become true");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class Webhooks extends ActivationDispatcher {
  readonly calls: Activation[] = [];
  onDispatch?: (activation: Activation) => Promise<void>;
  override async dispatch(_url: string, activation: Activation): Promise<void> {
    this.calls.push(activation);
    await this.onDispatch?.(activation);
  }
}
class Terminals extends TerminalDispatcher {
  readonly calls: string[] = [];
  override async dispatch(_target: TerminalActivationTarget, prompt: string): Promise<void> {
    this.calls.push(prompt);
  }
}

async function fixture(options: { dir?: string; windowMs?: number; gate?: ActivationGate } = {}) {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agent-delivery-pause-"));
  const store = await AgentInboxStore.open(path.join(dir, "inbox.sqlite"));
  const webhooks = new Webhooks();
  const terminals = new Terminals();
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store,
    (input: AppendSourceEventInput) => service.appendSourceEvent(input), { homeDir: dir });
  service = new AgentInboxService(store, adapters, webhooks, undefined,
    { windowMs: options.windowMs ?? 5 }, terminals, options.gate);
  const register = (agentId = "paused-agent") => service.registerAgent({
    agentId, runtimeKind: "holon",
    webhook: { url: "http://127.0.0.1:1/wake", activationMode: "activation_with_items" },
  });
  const cleanup = async (remove = true) => {
    for (const agent of store.listAgents()) service.pauseAgent(agent.agentId);
    await service.stop();
    store.close();
    if (remove) fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, service, adapters, webhooks, terminals, register, cleanup };
}

test("agent pause gates buffers and catches up unacked backlog once per target without new entries", async () => {
  const fx = await fixture({ windowMs: 60_000 });
  try {
    const { agent, webhookTarget } = fx.register();
    const second = fx.service.addWebhookActivationTarget(agent.agentId, {
      url: "http://127.0.0.1:2/wake", activationMode: "activation_with_items",
    });
    await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "buffered before pause" });
    assert.equal(fx.service.pauseAgent(agent.agentId).paused, true);
    assert.equal(fx.service.pauseAgent(agent.agentId).paused, false);
    const pausedMessage = await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "while paused" });
    assert.equal(pausedMessage.activated, false);
    const entries = fx.service.listInboxItems(agent.agentId);
    await fx.service.ackInboxItems(agent.agentId, [entries[0].entryId]);
    const before = fx.service.listInboxItems(agent.agentId, { includeAcked: true });
    await fx.service.stop(); // Also exercises the public shutdown buffer flush.
    assert.equal(fx.webhooks.calls.length, 0);
    const policy = fx.service.getInboxAggregationPolicy(agent.agentId);
    const resumed = await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.agent.deliveryPaused, false);
    assert.equal(fx.webhooks.calls.length, 2);
    assert.deepEqual(new Set(fx.webhooks.calls.map((call) => call.targetId)),
      new Set([webhookTarget!.targetId, second.targetId]));
    for (const call of fx.webhooks.calls) {
      assert.equal(call.entries?.length, 1);
      assert.equal(call.entries?.[0].entryId, entries[1].entryId);
    }
    await Promise.all([fx.service.resumeAgent(agent.agentId, { deliveryOnly: true }), fx.service.resumeAgent(agent.agentId, { deliveryOnly: true })]);
    assert.equal(fx.webhooks.calls.length, 2);
    assert.deepEqual(fx.service.listInboxItems(agent.agentId, { includeAcked: true }), before);
    assert.deepEqual(fx.service.getInboxAggregationPolicy(agent.agentId), policy);
  } finally { await fx.cleanup(); }
});

test("pause persists through restart and registration without affecting another agent", async () => {
  let fx = await fixture();
  const dir = fx.dir;
  try {
    fx.register();
    fx.register("other-agent");
    fx.service.pauseAgent("paused-agent");
    fx.register(); // Registration is not a delivery resume.
    assert.equal(fx.service.getAgent("paused-agent").deliveryPaused, true);
    await fx.service.addDirectInboxTextMessage("paused-agent", { message: "persisted" });
    await fx.service.addDirectInboxTextMessage("other-agent", { message: "independent" });
    await until(() => fx.webhooks.calls.length === 1);
    assert.equal(fx.webhooks.calls[0].agentId, "other-agent");
    await fx.cleanup(false);
    fx = await fixture({ dir });
    assert.equal(fx.service.getAgent("paused-agent").deliveryPaused, true);
    await fx.service.start();
    await sleep(20);
    assert.equal(fx.webhooks.calls.length, 0);
    await fx.service.resumeAgent("paused-agent", { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 1);
    assert.equal(fx.service.listInboxItems("paused-agent").length, 1);
  } finally { await fx.cleanup(); }
});

test("explicit delivery resume preserves offline targets across restart; default resume still recovers them", async () => {
  let fx = await fixture();
  try {
    const { agent, webhookTarget } = fx.register();
    const offline = () => {
      const now = new Date().toISOString();
      fx.store.updateActivationTargetRuntime(webhookTarget!.targetId, {
        status: "offline", offlineSince: now, consecutiveFailures: 4, lastError: "gone", updatedAt: now,
      });
      return fx.service.getActivationTarget(webhookTarget!.targetId);
    };
    offline();
    const legacy = await fx.service.resumeAgent(agent.agentId);
    assert.equal(legacy.resumed, true);
    assert.equal(legacy.targets[0].reason, "webhook_resumed");
    fx.service.pauseAgent(agent.agentId);
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    let targetBefore = offline();
    await fx.service.stop();
    fx.store.close();
    fx = await fixture({ dir: fx.dir });
    fx.register();
    // Re-registering the webhook intentionally refreshes its target state.
    targetBefore = offline();
    const resumed = await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(resumed.resumed, false);
    assert.deepEqual(resumed.targets, []);
    assert.deepEqual(fx.service.getActivationTarget(webhookTarget!.targetId), targetBefore);
    fx.service.pauseAgent(agent.agentId);
    const recovered = await fx.service.resumeAgent(agent.agentId);
    assert.equal(recovered.agent.deliveryPaused, false);
    assert.equal(recovered.targets[0].reason, "webhook_resumed");
    offline();
    const repeated = await fx.service.resumeAgent(agent.agentId);
    assert.equal(repeated.targets[0].reason, "webhook_resumed");
  } finally { await fx.cleanup(); }
});

test("concurrent resume scopes preserve target recovery in either order", async () => {
  for (const deliveryFirst of [true, false]) {
    const fx = await fixture();
    const entered = deferred();
    const release = deferred();
    try {
      const { agent } = fx.register();
      const offline = fx.service.addWebhookActivationTarget(agent.agentId, { url: "http://127.0.0.1:2/wake" });
      const now = new Date().toISOString();
      fx.store.updateActivationTargetRuntime(offline.targetId, {
        status: "offline", offlineSince: now, consecutiveFailures: 4, lastError: "gone", updatedAt: now,
      });
      fx.service.pauseAgent(agent.agentId);
      await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "mixed scope catch-up" });
      fx.webhooks.onDispatch = async () => { entered.resolve(); await release.promise; };
      const first = fx.service.resumeAgent(agent.agentId, { deliveryOnly: deliveryFirst });
      await entered.promise;
      const second = fx.service.resumeAgent(agent.agentId, { deliveryOnly: !deliveryFirst });
      release.resolve();
      const results = await Promise.all([first, second]);
      assert.deepEqual(results[deliveryFirst ? 0 : 1].targets, []);
      assert.ok(results[deliveryFirst ? 1 : 0].targets.some((target) =>
        target.targetId === offline.targetId && target.reason === "webhook_resumed"));
      assert.equal(fx.service.getActivationTarget(offline.targetId).status, "active");
      assert.equal(fx.service.getAgent(agent.agentId).deliveryPaused, false);
      assert.equal(fx.webhooks.calls.length, deliveryFirst ? 1 : 2);
    } finally { release.resolve(); await fx.cleanup(); }
  }
});

test("paused collection, matching, digest materialization, timer firing and explicit replies continue", async () => {
  const fx = await fixture();
  try {
    const { agent } = fx.register();
    fx.service.pauseAgent(agent.agentId);
    fx.service.updateInboxAggregationPolicy(agent.agentId, { enabled: true, maxItems: 2, windowMs: 60_000 });
    const source = await fx.service.registerSource({ sourceType: "local_event", sourceKey: "paused-events", config: {} });
    const subscription = await fx.service.registerSubscription({ agentId: agent.agentId, sourceId: source.sourceId });
    fx.adapters.deriveNotificationGrouping = async () => ({
      groupable: true, resourceRef: "resource:1", eventFamily: "updates", flushClass: "immediate",
    });
    fx.adapters.summarizeDigestThread = async (_source, items) => `${items.length} updates`;
    for (let i = 0; i < 2; i++) {
      await fx.service.appendSourceEvent({
        sourceId: source.sourceId, sourceNativeId: `event-${i}`, eventVariant: "updated",
        rawPayload: { text: `event ${i}` },
      });
      await fx.service.pollSubscription(subscription.subscriptionId);
    }
    assert.equal(fx.service.listRawInboxItems(agent.agentId).length, 2);
    assert.ok(fx.service.listInboxItems(agent.agentId).some((entry) => entry.kind === "digest_snapshot"));
    const timer = fx.service.registerTimer({
      agentId: agent.agentId, at: new Date(Date.now() + 40).toISOString(), message: "timer while paused",
    });
    await until(() => fx.service.getTimer(timer.scheduleId).lastFiredAt != null);
    assert.equal(fx.webhooks.calls.length, 0);
    let replied = false;
    fx.adapters.deliveryAdapterFor = () => ({
      send: async () => { replied = true; return { status: "sent", note: "sent" }; },
    });
    await fx.service.sendDelivery({
      deliveryHandle: { provider: "test", surface: "test", targetRef: "recipient" },
      kind: "reply", payload: { text: "explicit reply" },
    });
    assert.equal(replied, true);
    const before = fx.service.listInboxItems(agent.agentId, { includeAcked: true });
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 1);
    assert.deepEqual(fx.service.listInboxItems(agent.agentId, { includeAcked: true }), before);
  } finally { await fx.cleanup(); }
});

test("pause during terminal gate await fences dispatch even if resume occurs before gate returns", async () => {
  const started = deferred();
  const release = deferred();
  let evaluations = 0;
  const fx = await fixture({ gate: {
    evaluate: async () => {
      if (++evaluations === 1) { started.resolve(); await release.promise; }
      return { outcome: "inject", reason: "available" };
    },
  } });
  try {
    const { agent } = fx.service.registerAgent({
      agentId: "terminal-agent", backend: "tmux", tmuxPaneId: "%991", runtimeKind: "codex",
    });
    await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "gate race" });
    await started.promise;
    fx.service.pauseAgent(agent.agentId);
    const resume = fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    release.resolve();
    await resume;
    assert.equal(fx.terminals.calls.length, 1, "only the resume catch-up may dispatch");
    assert.equal(evaluations, 2);
  } finally { release.resolve(); await fx.cleanup(); }
});

test("pause permits already-started webhook completion; concurrent resumes serialize one catch-up", async () => {
  const fx = await fixture();
  const started = deferred();
  const release = deferred();
  try {
    fx.register();
    fx.webhooks.onDispatch = async () => { started.resolve(); await release.promise; };
    await fx.service.addDirectInboxTextMessage("paused-agent", { message: "in flight" });
    await started.promise;
    fx.service.pauseAgent("paused-agent");
    await fx.service.addDirectInboxTextMessage("paused-agent", { message: "backlog" });
    const resumes = Promise.all([fx.service.resumeAgent("paused-agent", { deliveryOnly: true }), fx.service.resumeAgent("paused-agent", { deliveryOnly: true })]);
    assert.equal(fx.webhooks.calls.length, 1);
    release.resolve();
    await resumes;
    assert.equal(fx.webhooks.calls.length, 2);
    assert.equal(fx.webhooks.calls[1].entries?.length, 2);
  } finally { release.resolve(); await fx.cleanup(); }
});

test("webhook may explicitly ack before returning without deadlocking the delivery lock", async () => {
  const fx = await fixture();
  try {
    fx.register();
    fx.webhooks.onDispatch = async () => { await fx.service.ackAllInboxItems("paused-agent"); };
    await fx.service.addDirectInboxTextMessage("paused-agent", { message: "ack in webhook" });
    await until(() => fx.service.listInboxItems("paused-agent").length === 0);
    await fx.service.stop();
    assert.equal(fx.webhooks.calls.length, 1);
  } finally { await fx.cleanup(); }
});

test("resume preserves offline targets and dirty retry backoff; target resume does not unpause", async () => {
  const fx = await fixture();
  try {
    const { agent, webhookTarget } = fx.register();
    const offline = fx.service.addWebhookActivationTarget(agent.agentId, { url: "http://127.0.0.1:2/wake" });
    const now = new Date().toISOString();
    fx.store.updateActivationTargetRuntime(offline.targetId, {
      status: "offline", offlineSince: now, consecutiveFailures: 4, lastError: "gone", updatedAt: now,
    });
    const targetBefore = fx.service.getActivationTarget(offline.targetId);
    fx.service.pauseAgent(agent.agentId);
    await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "retry backlog" });
    fx.store.upsertActivationDispatchState({
      agentId: agent.agentId, targetId: webhookTarget!.targetId, status: "dirty",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), lastNotifiedFingerprint: null,
      deferReason: null, deferAttempts: 0, firstDeferredAt: null, lastDeferredAt: null,
      pendingFingerprint: null, pendingNewItemCount: 1, pendingSummary: "retry",
      pendingSubscriptionIds: [], pendingSourceIds: [], updatedAt: now,
    });
    const stateBefore = fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId);
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 0);
    const stateAfter = fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId)!;
    assert.equal(stateAfter.leaseExpiresAt, stateBefore!.leaseExpiresAt);
    assert.equal(stateAfter.deferAttempts, stateBefore!.deferAttempts);
    assert.deepEqual(fx.service.getActivationTarget(offline.targetId), targetBefore);
    for (let i = 0; i < 2; i++) {
      const repeated = await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
      assert.equal(repeated.resumed, false);
      assert.deepEqual(repeated.targets, []);
      assert.deepEqual(fx.service.getActivationTarget(offline.targetId), targetBefore);
      assert.deepEqual(fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId), stateAfter);
      assert.equal(fx.webhooks.calls.length, 0);
    }
    fx.service.pauseAgent(agent.agentId);
    await fx.service.resumeActivationTarget(agent.agentId, offline.targetId);
    assert.equal(fx.service.getAgent(agent.agentId).deliveryPaused, true);
    fx.store.upsertActivationDispatchState({ ...stateBefore!, leaseExpiresAt: now });
    await fx.service.start(); // Expired dirty retry must still respect the pause.
    assert.equal(fx.webhooks.calls.length, 0);
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 2);
  } finally { await fx.cleanup(); }
});

test("HTTP and CLI expose persisted agent delivery pause and compatible resume", async () => {
  const fx = await fixture();
  const server = createServer(fx.service);
  try {
    fx.register();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const pause = await fetch(`${baseUrl}/agents/paused-agent/pause`, { method: "POST" });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json() as any).agent.deliveryPaused, true);
    const offline = fx.service.addWebhookActivationTarget("paused-agent", { url: "http://127.0.0.1:2/wake" });
    const now = new Date().toISOString();
    fx.store.updateActivationTargetRuntime(offline.targetId, {
      status: "offline", offlineSince: now, consecutiveFailures: 4, lastError: "gone", updatedAt: now,
    });
    const cli = async (action: string, ...flags: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["-r", "ts-node/register", "src/cli.ts", "agent", action, "paused-agent", ...flags], {
        cwd: path.resolve(__dirname, ".."), env: { ...process.env, AGENTINBOX_URL: baseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const resumed = await cli("resume", "--delivery");
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).agent.deliveryPaused, false);
    assert.equal(fx.service.getActivationTarget(offline.targetId).status, "offline");
    const repeated = await fetch(`${baseUrl}/agents/paused-agent/resume`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deliveryOnly: true }),
    });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as any).resumed, false);
    assert.equal(fx.service.getActivationTarget(offline.targetId).status, "offline");
    const legacy = await cli("resume");
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.equal(fx.service.getActivationTarget(offline.targetId).status, "active");
    const noBody = await fetch(`${baseUrl}/agents/paused-agent/resume`, { method: "POST" });
    assert.equal(noBody.status, 200);
    const paused = await cli("pause");
    assert.equal(paused.code, 0, paused.stderr);
    assert.equal(JSON.parse(paused.stdout).agent.deliveryPaused, true);
    const missing = await fetch(`${baseUrl}/agents/unknown/pause`, { method: "POST" });
    assert.equal(missing.status, 404);
    const shown = await fetch(`${baseUrl}/agents/paused-agent`).then((response) => response.json()) as any;
    assert.equal(shown.agent.deliveryPaused, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fx.cleanup();
  }
});

test("existing agents migrate to delivery enabled without losing their lifecycle state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-delivery-pause-upgrade-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const db = new BetterSqlite3(dbPath);
  db.exec("create table __drizzle_migrations (id integer primary key autoincrement, tag text not null unique, applied_at text not null)");
  const migrationsDir = path.resolve(__dirname, "../drizzle/migrations");
  for (const name of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql") && name < "0012").sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
    db.prepare("insert into __drizzle_migrations(tag, applied_at) values (?, ?)")
      .run(name.replace(/\.sql$/, ""), new Date().toISOString());
  }
  const now = new Date().toISOString();
  db.prepare(`insert into agents(agent_id, status, offline_since, runtime_kind, created_at, updated_at, last_seen_at)
    values (?, ?, ?, ?, ?, ?, ?)`).run("existing", "offline", now, "holon", now, now, now);
  db.close();
  const store = await AgentInboxStore.open(dbPath);
  try {
    assert.equal(store.getAgent("existing")!.deliveryPaused, false);
    assert.equal(store.getAgent("existing")!.status, "offline");
    assert.equal(store.getAgent("existing")!.offlineSince, now);
    store.setAgentDeliveryPaused("existing", true);
    assert.equal(store.getAgent("existing")!.status, "offline");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed resume catch-up retains normal webhook retry/backoff state", async () => {
  const fx = await fixture();
  try {
    const { agent, webhookTarget } = fx.register();
    fx.service.pauseAgent(agent.agentId);
    await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "retry on resume" });
    fx.webhooks.onDispatch = async () => { throw Object.assign(new Error("temporary failure"), { statusCode: 500 }); };
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 1);
    const state = fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId)!;
    assert.equal(state.status, "dirty");
    assert.ok(Date.parse(state.leaseExpiresAt!) > Date.now());
    assert.equal(fx.service.getActivationTarget(webhookTarget!.targetId).consecutiveFailures, 1);
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 1);
    fx.store.upsertActivationDispatchState({ ...state, leaseExpiresAt: new Date().toISOString() });
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 2);
    assert.equal(fx.service.getActivationTarget(webhookTarget!.targetId).consecutiveFailures, 2);
    const retried = fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId)!;
    assert.equal(retried.status, "dirty");
    fx.webhooks.onDispatch = undefined;
    fx.store.upsertActivationDispatchState({ ...retried, leaseExpiresAt: new Date().toISOString() });
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 3);
    assert.equal(fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId)!.status, "notified");
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 3, "successful catch-up must not replay on another resume");
  } finally { await fx.cleanup(); }
});

test("restart retries durable catch-up if the process stops immediately after unpause", async () => {
  const fx = await fixture();
  const recoveredDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resume-recovery-"));
  let recovered: Awaited<ReturnType<typeof fixture>> | undefined;
  const setPaused = fx.store.setAgentDeliveryPaused.bind(fx.store);
  try {
    const { agent, webhookTarget } = fx.register();
    fx.service.pauseAgent(agent.agentId);
    await fx.service.addDirectInboxTextMessage(agent.agentId, { message: "durable catch-up" });
    await sleep(30);
    fx.store.setAgentDeliveryPaused = (agentId, paused) => {
      const updated = setPaused(agentId, paused);
      if (!paused) throw new Error("simulated process interruption");
      return updated;
    };
    await assert.rejects(fx.service.resumeAgent(agent.agentId, { deliveryOnly: true }), /simulated process interruption/);
    fx.store.setAgentDeliveryPaused = setPaused;
    assert.equal(fx.store.getAgent(agent.agentId)!.deliveryPaused, false);
    assert.equal(fx.store.getActivationDispatchState(agent.agentId, webhookTarget!.targetId)!.status, "dirty");
    const database = new BetterSqlite3(path.join(fx.dir, "inbox.sqlite"));
    try { await database.backup(path.join(recoveredDir, "inbox.sqlite")); }
    finally { database.close(); }
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 1, "same-process retry must use the durable dirty state");
    await fx.service.resumeAgent(agent.agentId, { deliveryOnly: true });
    assert.equal(fx.webhooks.calls.length, 1);
    recovered = await fixture({ dir: recoveredDir });
    await recovered.service.start();
    assert.equal(recovered.webhooks.calls.length, 1);
    assert.equal(recovered.service.listInboxItems(agent.agentId).length, 1);
  } finally {
    fx.store.setAgentDeliveryPaused = setPaused;
    await fx.cleanup();
    if (recovered) await recovered.cleanup();
    else fs.rmSync(recoveredDir, { recursive: true, force: true });
  }
});
