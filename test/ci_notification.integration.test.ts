import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdapterRegistry } from "../src/adapters";
import { Activation, AppendSourceEventInput } from "../src/model";
import { ActivationDispatcher, AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";
import { normalizeGithubWorkflowRunEvent, parseGithubCiSourceConfig } from "../src/sources/github_ci";

class RecordingDispatcher extends ActivationDispatcher {
  readonly calls: Activation[] = [];
  fail = false;

  override async dispatch(_url: string, activation: Activation): Promise<void> {
    if (this.fail) {
      throw Object.assign(new Error("temporary webhook failure"), { statusCode: 500 });
    }
    this.calls.push(activation);
  }
}

// Exercise the real built-in module, SQLite store and delivery path without
// starting source polling or requiring external provider credentials.
async function openFixture(dir: string, dispatcher: RecordingDispatcher) {
  const store = await AgentInboxStore.open(path.join(dir, "inbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(
    store,
    async (input: AppendSourceEventInput) => service.appendSourceEvent(input),
    { homeDir: dir },
  );
  service = new AgentInboxService(store, adapters, dispatcher, undefined, {
    windowMs: 60_000,
    maxItems: 1_000,
  });
  const internal = service as unknown as {
    flushAllPendingNotifications(): Promise<void>;
    syncPendingDigestThreads(force: boolean): Promise<void>;
    syncActivationDispatchStates(): Promise<void>;
  };
  return { store, service, internal };
}

async function fixture(config: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-ci-policy-"));
  const dispatcher = new RecordingDispatcher();
  const opened = await openFixture(dir, dispatcher);
  const { store, service } = opened;
  const registered = service.registerAgent({
    agentId: "ci-policy-test",
    webhook: { url: "http://127.0.0.1:9999/wake", notifyLeaseMs: 60_000 },
  });
  const agentId = registered.agent.agentId;
  const targetId = registered.webhookTarget!.targetId;
  service.updateInboxAggregationPolicy(agentId, {
    enabled: true, windowMs: 60_000, maxItems: 2, maxThreadAgeMs: 3_600_000,
  });
  const now = new Date().toISOString();
  store.insertSource({
    sourceId: "ci-source",
    hostId: "github-ci-host",
    streamKind: "ci_runs",
    streamKey: "test/repo",
    sourceType: "github_repo_ci",
    sourceKey: "test/repo",
    configRef: null,
    config: { owner: "test", repo: "repo", expectedWorkflowIds: [11, 22], ...config },
    status: "active", checkpoint: null, createdAt: now, updatedAt: now,
  });
  const subscription = await service.registerSubscription({
    agentId, sourceId: "ci-source", filter: {},
    cleanupPolicy: { mode: "manual" }, startPolicy: "earliest",
  });
  const source = store.getSource("ci-source")!;
  const sourceConfig = parseGithubCiSourceConfig(source);
  let sequence = 0;
  async function append(
    instance: AgentInboxService,
    workflowId: number,
    conclusion: string | null,
    options: { attempt?: number; sha?: string; status?: string } = {},
  ) {
    sequence += 1;
    const event = normalizeGithubWorkflowRunEvent(source, sourceConfig, {
      id: workflowId * 100,
      workflow_id: workflowId,
      run_attempt: options.attempt ?? 1,
      head_sha: options.sha ?? "abcdef123456",
      status: options.status ?? (conclusion ? "completed" : "in_progress"),
      conclusion,
      name: `workflow-${workflowId}`,
      pull_requests: [{ number: 42 }],
      created_at: now,
      updated_at: new Date(Date.parse(now) + sequence).toISOString(),
    });
    assert.ok(event);
    await instance.appendSourceEvent(event);
    await instance.pollSubscription(subscription.subscriptionId);
  }
  function expire(currentStore: AgentInboxStore) {
    const state = currentStore.getActivationDispatchState(agentId, targetId);
    assert.ok(state);
    currentStore.upsertActivationDispatchState({
      ...state, leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
  }
  return { ...opened, dir, dispatcher, agentId, targetId, append, expire };
}

test("CI success waits for every declared workflow, not the threshold or a force sweep", async () => {
  const f = await fixture();
  try {
    await f.append(f.service, 11, null);
    await f.append(f.service, 11, "success");
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId).length, 0);
    await f.append(f.service, 22, null);
    await f.append(f.service, 22, "success");
    await f.internal.syncPendingDigestThreads(true);
    const entries = f.service.listInboxItems(f.agentId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.count, 4, "the snapshot still includes all unacked raw items");
    assert.match(entries[0]!.summary, /abcdef1/);
    assert.match(entries[0]!.summary, /2 passed/);
    await f.internal.flushAllPendingNotifications();
    assert.equal(f.dispatcher.calls.length, 1);
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId)[0]!.entryId, entries[0]!.entryId);
  } finally {
    await f.service.stop();
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CI pending success evidence survives the digest thread age limit", async () => {
  const f = await fixture();
  try {
    f.service.updateInboxAggregationPolicy(f.agentId, {
      enabled: true, windowMs: 60_000, maxItems: 2, maxThreadAgeMs: 1,
    });
    await f.append(f.service, 11, "success");
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId).length, 0);
    const firstThread = f.store.listOpenDigestThreads()[0]!;
    assert.equal(f.store.getDigestNotificationState(firstThread.inboxId, firstThread.groupKey), null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.append(f.service, 22, "success");
    await f.internal.syncPendingDigestThreads(true);
    const entries = f.service.listInboxItems(f.agentId);
    assert.equal(entries.length, 1, "age rotation must not discard the first workflow's pending success");
    assert.equal(entries[0]!.kind, "digest_snapshot");
    assert.equal(entries[0]!.threadId, firstThread.threadId);
    assert.equal(entries[0]!.count, 2);
    assert.match(entries[0]!.summary, /2 passed/);
    assert.doesNotMatch(entries[0]!.summary, /incomplete|unknown/);
    await f.internal.flushAllPendingNotifications();
    assert.equal(f.dispatcher.calls.length, 1);
  } finally {
    await f.service.stop();
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CI first failure and final result survive an existing notify lease and restart", async () => {
  const f = await fixture();
  let current = { store: f.store, service: f.service, internal: f.internal };
  try {
    await f.service.addDirectInboxTextMessage(f.agentId, { message: "already notified" });
    await f.internal.flushAllPendingNotifications();
    assert.equal(f.dispatcher.calls.length, 1);
    await f.append(f.service, 22, null);
    await f.append(f.service, 11, "failure");
    const first = f.service.listInboxItems(f.agentId).find((entry) => entry.kind === "digest_snapshot");
    assert.ok(first, "first failure must materialize without waiting for the other workflow");
    assert.match(first.summary, /failed|failure/);
    await f.internal.flushAllPendingNotifications();
    assert.equal(f.dispatcher.calls.length, 1, "the active lease is respected");
    assert.equal(f.store.getActivationDispatchState(f.agentId, f.targetId)?.status, "dirty");
    await f.service.stop();
    f.store.close();
    current = await openFixture(f.dir, f.dispatcher);
    f.expire(current.store);
    await current.internal.syncActivationDispatchStates();
    assert.equal(f.dispatcher.calls.length, 2, "pending first failure is delivered after restart");
    assert.match(f.dispatcher.calls[1]!.summary ?? "", /failed|failure/);
    await f.append(current.service, 22, "success");
    await current.internal.flushAllPendingNotifications();
    const final = current.service.listInboxItems(f.agentId).find((entry) => entry.kind === "digest_snapshot");
    assert.ok(final);
    assert.ok(final.revision! > first.revision!);
    assert.equal(f.dispatcher.calls.length, 2, "the final result waits durably behind the lease");
    f.expire(current.store);
    await current.internal.syncActivationDispatchStates();
    assert.equal(f.dispatcher.calls.length, 3);
    assert.match(f.dispatcher.calls[2]!.summary ?? "", /failed|failure/);
    assert.match(f.dispatcher.calls[2]!.summary ?? "", /1 passed/);
    f.expire(current.store);
    await current.internal.syncActivationDispatchStates();
    assert.equal(f.dispatcher.calls.length, 3, "an unchanged result does not notify again");
  } finally {
    await current.service.stop();
    current.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CI ack keeps cycle evidence, and a newer attempt can recover after GC and restart", async () => {
  const f = await fixture();
  let current = { store: f.store, service: f.service, internal: f.internal };
  try {
    await f.append(f.service, 22, null);
    await f.append(f.service, 11, "failure");
    const first = f.service.listInboxItems(f.agentId)[0]!;
    await f.service.ackInbox(f.agentId, { entryIds: [first.entryId] });
    assert.equal(f.service.listInboxItems(f.agentId).length, 0);
    await f.append(f.service, 22, "success");
    const final = f.service.listInboxItems(f.agentId)[0]!;
    assert.ok(final);
    assert.match(final.summary, /1 failed|failure/);
    assert.match(final.summary, /1 passed/);
    await f.service.ackInbox(f.agentId, { all: true });
    f.store.deleteAckedInboxItemsGlobal(new Date(Date.now() + 86_400_000).toISOString());
    await f.service.stop();
    f.store.close();
    current = await openFixture(f.dir, f.dispatcher);
    await f.append(current.service, 11, null, { attempt: 2 });
    await f.append(current.service, 11, "success", { attempt: 2 });
    const recovered = current.service.listInboxItems(f.agentId)[0]!;
    assert.ok(recovered, "a rerun starts a fresh evaluation and publishes recovery");
    assert.match(recovered.summary, /2 passed/);
    assert.doesNotMatch(recovered.summary, /1 failed/);
    await f.append(current.service, 11, "failure", { attempt: 1 });
    await current.internal.syncPendingDigestThreads(true);
    assert.equal(current.service.listInboxItems(f.agentId)[0]!.entryId, recovered.entryId);
  } finally {
    await current.service.stop();
    current.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const conclusion of ["success", "failure"]) {
  test(`CI same-conclusion ${conclusion} rerun survives real event deduplication`, async () => {
    const f = await fixture();
    try {
      await f.append(f.service, 22, "success");
      await f.append(f.service, 11, null);
      await f.append(f.service, 11, conclusion);
      const first = f.service.listInboxItems(f.agentId)[0]!;
      assert.ok(first);
      await f.service.ackInbox(f.agentId, { all: true });
      await f.append(f.service, 11, null, { attempt: 2 });
      assert.equal(f.service.listInboxItems(f.agentId).length, 0);
      await f.append(f.service, 11, conclusion, { attempt: 2 });
      const rerun = f.service.listInboxItems(f.agentId)[0]!;
      assert.ok(rerun, "a new attempt with the same conclusion must publish a new result");
      assert.notEqual(rerun.entryId, first.entryId);
      assert.match(rerun.summary, conclusion === "success" ? /2 passed/ : /1 failed|failure/);
      await f.append(f.service, 11, conclusion, { attempt: 2 });
      assert.equal(f.service.listInboxItems(f.agentId).length, 1);
      assert.equal(f.service.listInboxItems(f.agentId)[0]!.entryId, rerun.entryId);
    } finally {
      await f.service.stop();
      f.store.close();
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

test("CI final-result delivery retries webhook failures without repeating snapshots", async () => {
  const f = await fixture();
  try {
    await f.append(f.service, 11, "success");
    await f.append(f.service, 22, "success");
    const entry = f.service.listInboxItems(f.agentId)[0]!;
    assert.ok(entry);
    f.dispatcher.fail = true;
    await f.internal.flushAllPendingNotifications();
    assert.equal(f.dispatcher.calls.length, 0);
    assert.equal(f.store.getActivationDispatchState(f.agentId, f.targetId)?.status, "dirty");
    f.dispatcher.fail = false;
    f.expire(f.store);
    await f.internal.syncActivationDispatchStates();
    assert.equal(f.dispatcher.calls.length, 1);
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId)[0]!.entryId, entry.entryId);
  } finally {
    await f.service.stop();
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CI ack reconciliation cannot publish a not-yet-eligible intermediate update", async () => {
  const f = await fixture();
  try {
    await f.append(f.service, 11, "failure");
    const first = f.service.listInboxItems(f.agentId)[0]!;
    assert.ok(first);
    await f.append(f.service, 22, null);
    await f.service.ackInbox(f.agentId, { entryIds: [first.entryId] });
    assert.equal(f.service.listInboxItems(f.agentId).length, 0,
      "ack is not authorization to materialize unpublished CI updates");
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId).length, 0);
    await f.append(f.service, 22, "success");
    const final = f.service.listInboxItems(f.agentId)[0]!;
    assert.ok(final);
    assert.match(final.summary, /failed|failure/);
    assert.match(final.summary, /1 passed/);
  } finally {
    await f.service.stop();
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CI materialization failure does not consume first-failure notification eligibility", async () => {
  const f = await fixture();
  const materialize = f.store.materializeDigestSnapshot.bind(f.store);
  try {
    await f.append(f.service, 22, null);
    f.store.materializeDigestSnapshot = () => { throw new Error("injected snapshot failure"); };
    await assert.rejects(f.append(f.service, 11, "failure"), /injected snapshot failure/);
    assert.equal(f.service.listInboxItems(f.agentId).length, 0);
    f.store.materializeDigestSnapshot = materialize;
    await f.internal.syncPendingDigestThreads(true);
    const first = f.service.listInboxItems(f.agentId)[0]!;
    assert.ok(first, "a failed commit must leave the first failure eligible");
    assert.match(first.summary, /failed|failure/);
    await f.internal.flushAllPendingNotifications();
    assert.equal(f.dispatcher.calls.length, 1);
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId)[0]!.entryId, first.entryId);
  } finally {
    f.store.materializeDigestSnapshot = materialize;
    await f.service.stop();
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CI unknown expected set reports incomplete at timeout, never complete success", async () => {
  const f = await fixture({ expectedWorkflowIds: undefined, digestFlushTimeoutSecs: 1 });
  try {
    await f.append(f.service, 11, "success");
    await f.append(f.service, 22, "success");
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await f.internal.syncPendingDigestThreads(true);
    const incomplete = f.service.listInboxItems(f.agentId)[0]!;
    assert.ok(incomplete);
    assert.match(incomplete.summary, /incomplete|unknown/i);
    await f.internal.syncPendingDigestThreads(true);
    assert.equal(f.service.listInboxItems(f.agentId)[0]!.entryId, incomplete.entryId);
  } finally {
    await f.service.stop();
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
