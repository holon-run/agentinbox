import assert from "node:assert/strict";
import { fork, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import BetterSqlite3 from "better-sqlite3";
import { AgentInboxStore } from "../src/store";
import { SqliteEventBusBackend } from "../src/backend";
import { HistoryUnavailableError } from "../src/stream_compaction";

type Reply = { ready?: boolean; ok?: boolean; value?: Record<string, unknown>; error?: Record<string, unknown> };

async function worker(dbPath: string, streamId: string) {
  const child = fork(path.join(__dirname, "fixtures/stream_compaction_worker.ts"), [dbPath, streamId], {
    execArgv: ["--require", "ts-node/register"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (data) => { stderr += String(data); });
  const next = () => new Promise<Reply>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`worker timed out: ${stderr}`)), 30_000);
    const onExit = (code: number | null) => finish(new Error(`worker exited ${code}: ${stderr}`));
    const onMessage = (message: Reply) => finish(null, message);
    const finish = (error: Error | null, message?: Reply) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error); else resolve(message!);
    };
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
  assert.equal((await next()).ready, true);
  return {
    child,
    run(command: Record<string, unknown>) {
      const result = next();
      child.send(command);
      return result;
    },
  };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `missing test barrier: ${path.basename(file)}`);
    await delay(5);
  }
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-tx-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const backend = new SqliteEventBusBackend(store);
  const stream = await backend.ensureStream({ sourceId: "source", streamKey: "events", backend: "sqlite" });
  const offset = store.insertStreamEvent(stream.streamId, {
    sourceId: "source", sourceNativeId: "event", eventVariant: "test",
    metadata: { original: true }, rawPayload: { secret: "original payload" },
  }).lastOffset!;
  const db = new BetterSqlite3(dbPath);
  db.prepare("update stream_events set created_at = '2000-01-01T00:00:00.000Z'").run();
  store.insertConsumer({
    consumerId: "existing", streamId: stream.streamId, subscriptionId: "existing",
    consumerKey: "existing", nextOffset: offset + 1, startPolicy: "latest",
    startOffset: null, startTime: null, createdAt: "2000-01-01", updatedAt: "2000-01-01",
  });
  const children: ChildProcess[] = [];
  return {
    dir, dbPath, store, backend, db, stream, offset,
    async worker() {
      const running = await worker(dbPath, stream.streamId);
      children.push(running.child);
      return running;
    },
    cleanup() {
      for (const child of children) child.kill();
      store.close();
      db.close();
      fs.rmSync(dir, { force: true, recursive: true });
    },
  };
}

test("a consumer committed before compaction protects history across processes", { timeout: 60_000 }, async () => {
  const fx = await fixture();
  try {
    const creating = await fx.worker();
    const compacting = await fx.worker();
    const gate = path.join(fx.dir, "create");
    const createResult = creating.run({ operation: "create", gate });
    await waitForFile(`${gate}.held`);
    const started = path.join(fx.dir, "apply-started");
    const applyResult = compacting.run({ operation: "apply", resolved: started });
    await waitForFile(started);
    fs.writeFileSync(`${gate}.release`, "");
    assert.equal((await createResult).ok, true);
    const applied = await applyResult;
    assert.equal(applied.ok, true);
    assert.equal(applied.value!.prunedEvents, 0);
    assert.equal(applied.value!.stopReason, "consumer_boundary");
    assert.equal(fx.store.readStreamEvents(fx.stream.streamId, fx.offset, 10).length, 1);
  } finally { fx.cleanup(); }
});

for (const operation of ["create", "reset", "commit"] as const) {
  test(`compaction committed before ${operation} rejects the stale resolved boundary across processes`,
    { timeout: 60_000 }, async () => {
      const fx = await fixture();
      try {
        const compacting = await fx.worker();
        const modifying = await fx.worker();
        const gate = path.join(fx.dir, "apply");
        const applying = compacting.run({ operation: "apply", gate });
        await waitForFile(`${gate}.held`);
        const resolved = path.join(fx.dir, "resolved");
        const modifyingResult = modifying.run({ operation, resolved });
        // The backend has resolved its offset against the OLD committed WAL
        // snapshot. Its store write must recheck after acquiring the writer lock.
        await waitForFile(resolved);
        fs.writeFileSync(`${gate}.release`, "");
        assert.equal((await applying).value!.prunedEvents, 1);
        const rejected = await modifyingResult;
        assert.equal(rejected.ok, false);
        assert.equal(rejected.error!.code, "history_unavailable");
        assert.equal(rejected.error!.retainedFromOffset, fx.offset + 1);
        assert.equal(fx.store.getConsumer("existing")!.nextOffset, fx.offset + 1);
        assert.equal(fx.store.getConsumerBySubscriptionId("racing"), null);
        assert.throws(() => fx.store.readStreamEvents(fx.stream.streamId, 1, 10), HistoryUnavailableError);
        const commits = fx.db.prepare("select count(*) as n from consumer_commits").get() as { n: number };
        assert.equal(commits.n, 0);
      } finally { fx.cleanup(); }
    });
}

test("a WAL reader sees original events before commit and duplicate append never restores compacted payloads",
  { timeout: 60_000 }, async () => {
    const fx = await fixture();
    try {
      const compacting = await fx.worker();
      const appending = await fx.worker();
      const gate = path.join(fx.dir, "apply");
      const applying = compacting.run({ operation: "apply", gate });
      await waitForFile(`${gate}.held`);
      const events = fx.store.readStreamEvents(fx.stream.streamId, 1, 10);
      assert.deepEqual(events[0].rawPayload, { secret: "original payload" });
      const started = path.join(fx.dir, "append-started");
      const appendingResult = appending.run({ operation: "append", resolved: started });
      await waitForFile(started);
      fs.writeFileSync(`${gate}.release`, "");
      assert.equal((await applying).value!.prunedEvents, 1);
      assert.equal((await appendingResult).value!.deduped, 1);
      const stub = fx.db.prepare("select * from stream_events").get() as Record<string, unknown>;
      assert.equal(stub.raw_payload_json, "{}");
      assert.ok(stub.payload_pruned_at);
      assert.equal(fx.store.getStreamStats(fx.stream.streamId).highWatermarkOffset, fx.offset);
    } finally { fx.cleanup(); }
  });
