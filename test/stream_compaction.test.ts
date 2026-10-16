import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import { AdapterRegistry } from "../src/adapters";
import { EventBusBackend, SqliteEventBusBackend } from "../src/backend";
import { createServer } from "../src/http";
import { AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";
import { compactionPreviewOptions } from "../src/stream_compaction";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z";
const CUTOFF = new Date(NOW - DAY).toISOString();

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const db = new BetterSqlite3(dbPath);
  const backend = new SqliteEventBusBackend(store);
  const stream = await backend.ensureStream({ sourceId: "source", streamKey: "events", backend: "sqlite" });
  let sequence = 0;
  const append = (createdAt = OLD, streamId = stream.streamId, payload = { message: "中文秘密" }) => {
    const offset = store.insertStreamEvent(streamId, {
      sourceId: "source", sourceNativeId: `event-${++sequence}`, eventVariant: "test",
      occurredAt: "2099-01-01T00:00:00.000Z",
      metadata: { type: "test" }, rawPayload: payload,
      providerRawPayload: { secret: "provider" },
      deliveryHandle: { provider: "test", surface: "test", targetRef: "secret" },
    }).lastOffset!;
    db.prepare("update stream_events set created_at = ? where offset = ?").run(createdAt, offset);
    return offset;
  };
  const consumer = (id: string, nextOffset: number, streamId = stream.streamId) => store.insertConsumer({
    consumerId: id, streamId, subscriptionId: id, consumerKey: id, nextOffset,
    startPolicy: "earliest", startOffset: null, startTime: null, createdAt: OLD, updatedAt: OLD,
  });
  const snapshot = () => Object.fromEntries(
    (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>)
      .map(({ name }) => [name, db.prepare(`select * from "${name.replace(/"/g, '""')}"`).all()]),
  );
  const cleanup = () => {
    db.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, db, backend, stream, append, consumer, snapshot, cleanup };
}

test("preview protects all consumers, counts UTF-8 field bytes and makes no business writes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fx = await fixture();
  try {
    const first = fx.append();
    const second = fx.append();
    fx.consumer("offline", second);
    fx.consumer("paused", second);
    fx.consumer("ahead", second + 20);
    const before = fx.snapshot();
    const dataVersion = fx.db.pragma("data_version", { simple: true });
    const result = await fx.backend.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY });
    assert.equal(result.cutoff, CUTOFF);
    assert.equal(result.candidateEvents, 1);
    assert.equal(result.protectedEvents, 1);
    assert.equal(result.safeBeforeOffset, second);
    assert.equal(result.candidateThroughOffset, first);
    assert.equal(result.projectedRetainedFromOffset, first + 1);
    assert.equal(result.stopReason, "consumer_boundary");
    assert.deepEqual(result.blockingConsumers.map((c) => c.consumerId), ["offline", "paused"]);
    const row = fx.db.prepare("select * from stream_events where offset = ?").get(first) as Record<string, string>;
    const expected = {
      metadata: Buffer.byteLength(row.metadata_json), rawPayload: Buffer.byteLength(row.raw_payload_json),
      providerRawPayload: Buffer.byteLength(row.provider_raw_payload_json),
      deliveryHandle: Buffer.byteLength(row.delivery_handle_json),
    };
    assert.deepEqual(result.candidatePayloadBytes, {
      ...expected, total: Object.values(expected).reduce((sum, size) => sum + size, 0),
    });
    assert.ok(!JSON.stringify(result).includes("秘密"));
    assert.equal(result.estimated, false);
    assert.deepEqual(fx.snapshot(), before);
    assert.equal(fx.db.pragma("data_version", { simple: true }), dataVersion);
    assert.deepEqual(await fx.backend.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY }), result);
  } finally { fx.cleanup(); }
});

test("preview uses a created_at prefix, stops at equality and allows global offset gaps", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fx = await fixture();
  try {
    const other = await fx.backend.ensureStream({ sourceId: "other", streamKey: "other", backend: "sqlite" });
    fx.append();
    fx.append(OLD, other.streamId);
    const second = fx.append();
    fx.append(CUTOFF); // Exactly at the cutoff is protected, regardless of occurred_at.
    fx.append(); // Do not punch a hole past the first retained event.
    fx.consumer("consumer", 100);
    const result = fx.store.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY });
    assert.equal(result.scannedEvents, 4);
    assert.equal(result.candidateEvents, 2);
    assert.equal(result.candidateThroughOffset, second);
    assert.equal(result.protectedEvents, 2);
    assert.equal(result.stopReason, "retention_boundary");
    assert.equal(fx.store.getStreamStats(other.streamId).eventCount, 1);
  } finally { fx.cleanup(); }
});

test("preview skips streams without consumers and handles empty streams without creating state", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fx = await fixture();
  try {
    fx.append();
    const before = fx.snapshot();
    const skipped = fx.store.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY });
    assert.equal(skipped.stopReason, "no_consumers");
    assert.equal(skipped.candidateEvents, 0);
    assert.equal(skipped.safeBeforeOffset, null);
    assert.deepEqual(fx.snapshot(), before);
    const empty = await fx.backend.ensureStream({ sourceId: "empty", streamKey: "empty", backend: "sqlite" });
    fx.consumer("empty", 1, empty.streamId);
    const preview = fx.store.previewStreamCompaction({ streamId: empty.streamId, retentionMs: DAY });
    assert.equal(preview.stopReason, "exhausted");
    assert.equal(preview.scannedEvents, 0);
    assert.equal(preview.projectedRetainedFromOffset, 1);
    assert.throws(() => fx.store.previewStreamCompaction({ streamId: "missing", retentionMs: DAY }), /unknown stream/);
  } finally { fx.cleanup(); }
});

test("preview bounds event/consumer diagnostics and marks truncated samples instead of claiming totals", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fx = await fixture();
  try {
    for (let i = 0; i < 4; i++) fx.append();
    for (let i = 0; i < 102; i++) fx.consumer(`consumer-${String(i).padStart(3, "0")}`, 100);
    const preview = fx.store.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY, scanLimit: 2 });
    assert.equal(preview.countsScope, "scanned_prefix");
    assert.equal(preview.scannedEvents, 2);
    assert.equal(preview.candidateEvents, 2);
    assert.equal(preview.hasMore, true);
    assert.equal(preview.estimated, true);
    assert.equal(preview.stopReason, "scan_limit");
    assert.equal(preview.blockingConsumers.length, 100);
    assert.equal(preview.blockingConsumersHasMore, true);
  } finally { fx.cleanup(); }
});

test("preview rejects nonpositive, unsafe and unbounded options at the store contract", () => {
  for (const retentionMs of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => compactionPreviewOptions({ streamId: "stream", retentionMs }), /invalid retentionMs/);
  }
  for (const scanLimit of [0, -1, 1.5, 1001, Infinity, NaN]) {
    assert.throws(() => compactionPreviewOptions({ streamId: "stream", retentionMs: DAY, scanLimit }), /invalid scanLimit/);
  }
});

test("HTTP and CLI preview stay read-only, validate options and reject unsupported backends", async (t) => {
  const fx = await fixture();
  const adapters = new AdapterRegistry(fx.store, async () => { throw new Error("preview must not append"); });
  // No service.start(): background polling/GC is intentionally outside this test.
  const service = new AgentInboxService(fx.store, adapters);
  const server = createServer(service);
  const source = await service.registerSource({ sourceType: "local_event", sourceKey: "preview-test", config: {} });
  const internal = fx.store.getStreamBySourceId(source.sourceId)!;
  fx.append(OLD, internal.streamId, { message: "sensitive".repeat(150_000) });
  fx.consumer("http-consumer", 100, internal.streamId);
  const endpoint = `/streams/${source.sourceId}/compaction-preview`;
  const before = fx.snapshot();
  // Inspection must not invoke a provider or silently ensure a missing stream.
  t.mock.method(adapters, "resolveSourceIdentity", async () => { throw new Error("provider called"); });
  t.mock.method(fx.backend, "ensureStream", async () => { throw new Error("ensure called"); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionMs: DAY }),
    });
    assert.equal(response.status, 200);
    const preview = await response.json() as any;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.sourceId, source.sourceId);
    assert.equal(preview.streamId, internal.streamId);
    assert.equal(preview.candidateEvents, 1);
    assert.ok(preview.candidatePayloadBytes.rawPayload > 1_000_000);
    assert.ok(!JSON.stringify(preview).includes("sensitive"));
    for (const options of [{ retentionMs: 0 }, { retentionMs: DAY, scanLimit: 1001 }, {}, { retentionMs: DAY, apply: true }]) {
      const invalid = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options),
      });
      assert.equal(invalid.status, 400, JSON.stringify(options));
    }
    const missing = await fetch(`${baseUrl}/streams/missing/compaction-preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionMs: DAY }),
    });
    assert.equal(missing.status, 404);
    const cli = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["-r", "ts-node/register", "src/cli.ts", "stream", "compact", source.sourceId, ...args], {
        cwd: path.resolve(__dirname, ".."), env: { ...process.env, AGENTINBOX_URL: baseUrl, AGENTINBOX_HOME: fx.dir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const output = await cli("--retention", "1d", "--dry-run", "--scan-limit", "1");
    assert.equal(output.code, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).candidateEvents, 1);
    assert.equal(JSON.parse(output.stdout).scanLimit, 1);
    for (const args of [[], ["--retention", "0"], ["--retention", "1d", "--apply", "--dry-run"]]) {
      const invalid = await cli(...args);
      assert.notEqual(invalid.code, 0);
    }
    assert.deepEqual(fx.snapshot(), before);
    const unsupported = new AgentInboxService(fx.store, adapters, undefined, {} as EventBusBackend);
    await assert.rejects(unsupported.previewStreamCompaction(source.sourceId, { retentionMs: DAY }),
      (error: any) => error.statusCode === 501 && /unsupported/.test(error.message));
    const noStream = await service.registerSource({ sourceType: "local_event", sourceKey: "missing-stream", config: {} });
    fx.db.prepare("delete from streams where source_id = ?").run(noStream.sourceId);
    const beforeMissing = fx.snapshot();
    await assert.rejects(service.previewStreamCompaction(noStream.sourceId, { retentionMs: DAY }), /unknown event stream/);
    assert.deepEqual(fx.snapshot(), beforeMissing);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await service.stop();
    fx.cleanup();
  }
});
