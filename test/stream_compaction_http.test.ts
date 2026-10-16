import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import { AdapterRegistry } from "../src/adapters";
import { EventBusBackend } from "../src/backend";
import { createServer } from "../src/http";
import { AgentInboxService } from "../src/service";
import { AgentInboxStore } from "../src/store";
import { HistoryUnavailableError } from "../src/stream_compaction";

const DAY = 86_400_000;

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-http-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const db = new BetterSqlite3(dbPath);
  const adapters = new AdapterRegistry(store, async () => { throw new Error("provider must not run"); });
  // Do not start the service: background source polling and maintenance are excluded.
  const service = new AgentInboxService(store, adapters);
  const source = await service.registerSource({ sourceType: "local_event", sourceKey: "compaction-http", config: {} });
  const stream = store.getStreamBySourceId(source.sourceId)!;
  for (let i = 0; i < 2; i++) {
    store.insertStreamEvent(stream.streamId, {
      sourceId: source.sourceId, sourceNativeId: `event-${i}`, eventVariant: "test",
      occurredAt: "2026-01-01T00:00:00.000Z", metadata: { type: "test" },
      rawPayload: { secret: "synthetic-payload" }, providerRawPayload: { secret: "synthetic-provider" },
      deliveryHandle: { provider: "test", surface: "test", targetRef: "synthetic" },
    });
  }
  db.prepare("update stream_events set created_at = ?").run("2020-01-01T00:00:00.000Z");
  store.insertConsumer({
    consumerId: "http-consumer", streamId: stream.streamId, subscriptionId: "http-consumer",
    consumerKey: "http-consumer", nextOffset: 100, startPolicy: "latest",
    startOffset: null, startTime: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const server = createServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = async (endpoint: string, body: unknown) => {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const get = async (endpoint: string) => {
    const response = await fetch(`${baseUrl}${endpoint}`);
    return { status: response.status, data: await response.json() as any };
  };
  const snapshot = () => db.prepare("select * from stream_events order by offset").all();
  const cli = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-r", "ts-node/register", "src/cli.ts", "stream", "compact", source.sourceId, ...args,
    ], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, AGENTINBOX_URL: baseUrl, AGENTINBOX_HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const cleanup = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await service.stop();
    db.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, adapters, service, source, stream, post, get, snapshot, cli, cleanup };
}

test("public source and stream details preserve fields and expose compaction statistics", async () => {
  const fx = await fixture();
  try {
    const endpoints = [`/sources/${fx.source.sourceId}`, `/streams/${fx.source.sourceId}`];
    const before = await fx.get(endpoints[0]);
    assert.equal(before.status, 200);
    const { streamStats: initialStats, ...originalFields } = before.data;
    assert.equal(originalFields.source.sourceId, fx.source.sourceId);
    assert.equal(originalFields.stream.streamId, fx.stream.streamId);
    for (const key of ["runtime", "host", "resolvedIdentity", "schema", "subscriptions", "idleState"]) {
      assert.ok(Object.hasOwn(originalFields, key), key);
    }
    assert.equal(initialStats.eventCount, 2);
    assert.equal(initialStats.replayableEventCount, 2);
    assert.equal(initialStats.prunedEventCount, 0);
    assert.equal(initialStats.prunedThroughOffset, null);
    const applied = await fx.post(`/streams/${fx.source.sourceId}/compaction-apply`,
      { apply: true, retentionMs: DAY });
    assert.equal(applied.status, 200);
    assert.equal(applied.data.prunedEvents, 2);
    for (const endpoint of endpoints) {
      const details = await fx.get(endpoint);
      assert.equal(details.status, 200);
      const { streamStats, ...fields } = details.data;
      assert.deepEqual(fields, originalFields);
      assert.deepEqual(streamStats, {
        streamId: fx.stream.streamId,
        eventCount: 2,
        replayableEventCount: 0,
        prunedEventCount: 2,
        prunedThroughOffset: initialStats.highWatermarkOffset,
        retainedFromOffset: initialStats.highWatermarkOffset + 1,
        highWatermarkOffset: initialStats.highWatermarkOffset,
      });
    }
  } finally { await fx.cleanup(); }
});

test("HTTP compaction requires explicit apply, validates limits, maps source IDs and is reentrant", async () => {
  const fx = await fixture();
  const endpoint = `/streams/${fx.source.sourceId}/compaction-apply`;
  try {
    const before = fx.snapshot();
    const preview = await fx.post(`/streams/${fx.source.sourceId}/compaction-preview`, { retentionMs: DAY });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.dryRun, true);
    assert.deepEqual(fx.snapshot(), before);
    for (const body of [
      {}, { retentionMs: DAY }, { apply: false, retentionMs: DAY }, { apply: "true", retentionMs: DAY },
      { apply: true, retentionMs: 0 }, { apply: true, retentionMs: DAY, scanLimit: 1 },
      { apply: true, retentionMs: DAY, dryRun: false }, { apply: true, retentionMs: DAY, typo: 1 },
      { apply: true, retentionMs: DAY, batchSize: 101 }, { apply: true, retentionMs: DAY, maxEvents: 1001 },
      { apply: true, retentionMs: DAY, maxPayloadBytes: 8388609 },
      { apply: true, retentionMs: DAY, batchSize: 0 }, { apply: true, retentionMs: DAY, maxEvents: 1.5 },
      { apply: true, retentionMs: DAY, maxPayloadBytes: "100" },
    ]) {
      const result = await fx.post(endpoint, body);
      assert.equal(result.status, 400, JSON.stringify(body));
    }
    assert.equal((await fx.post(`/streams/${fx.source.sourceId}/compaction-preview`,
      { retentionMs: DAY, apply: true })).status, 400);
    assert.deepEqual(fx.snapshot(), before);
    assert.equal((await fx.post("/streams/missing/compaction-apply", { apply: true, retentionMs: DAY })).status, 404);
    const first = await fx.post(endpoint, { apply: true, retentionMs: DAY, batchSize: 1, maxEvents: 1 });
    assert.equal(first.status, 200);
    assert.equal(first.data.sourceId, fx.source.sourceId);
    assert.equal(first.data.streamId, fx.stream.streamId);
    assert.equal(first.data.dryRun, false);
    assert.equal(first.data.prunedEvents, 1);
    assert.equal(first.data.batches, 1);
    assert.equal(first.data.hasMore, true);
    assert.ok(!JSON.stringify(first.data).includes("synthetic-payload"));
    const second = await fx.post(endpoint, { apply: true, retentionMs: DAY });
    assert.equal(second.status, 200);
    assert.equal(second.data.prunedEvents, 1);
    const repeated = await fx.post(endpoint, { apply: true, retentionMs: DAY });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.prunedEvents, 0);
  } finally { await fx.cleanup(); }
});

test("unsupported service/backend and HTTP return 501, never successful fallback", async () => {
  const fx = await fixture();
  try {
    const unsupported = new AgentInboxService(fx.store, fx.adapters, undefined, {} as EventBusBackend);
    await assert.rejects(unsupported.applyStreamCompaction(fx.source.sourceId, { retentionMs: DAY }),
      (error: any) => error.statusCode === 501 && /unsupported/.test(error.message));
    // Exercise the HTTP mapping without changing the backend's storage implementation.
    const original = fx.service.applyStreamCompaction.bind(fx.service);
    fx.service.applyStreamCompaction = unsupported.applyStreamCompaction.bind(unsupported);
    const before = fx.snapshot();
    const response = await fx.post(`/streams/${fx.source.sourceId}/compaction-apply`, { apply: true, retentionMs: DAY });
    assert.equal(response.status, 501);
    assert.match(response.data.error, /unsupported/);
    assert.deepEqual(fx.snapshot(), before);
    fx.service.applyStreamCompaction = original;
  } finally { await fx.cleanup(); }
});

test("HTTP schemas preserve structured history errors for apply, follow, create, read and reset", async (t) => {
  const fx = await fixture();
  try {
    const requested = { offset: 1, time: "2020-01-01T00:00:00Z", startPolicy: "earliest" };
    const error = new HistoryUnavailableError(fx.stream.streamId, requested, 3, 2);
    const fail = async (): Promise<never> => { throw error; };
    t.mock.method(fx.service, "applyStreamCompaction", fail);
    t.mock.method(fx.service, "follow", fail);
    t.mock.method(fx.service, "registerSubscriptions", fail);
    t.mock.method(fx.service, "pollSubscription", fail);
    t.mock.method(fx.service, "resetSubscription", fail);
    for (const [endpoint, body] of [
      [`/streams/${fx.source.sourceId}/compaction-apply`, { apply: true, retentionMs: DAY }],
      ["/follow", { agentId: "agent", providerOrKind: "test", template: "test" }],
      ["/subscriptions", { agentId: "agent", sourceId: fx.source.sourceId }],
      ["/subscriptions/test/poll", {}],
      ["/subscriptions/test/reset", { startPolicy: "earliest" }],
    ] as const) {
      const response = await fx.post(endpoint, body);
      assert.equal(response.status, 409, endpoint);
      assert.deepEqual(response.data, {
        error: error.message, code: "history_unavailable", streamId: fx.stream.streamId,
        requested, retainedFromOffset: 3, highWatermarkOffset: 2,
      }, endpoint);
    }
    const nullBounds = new HistoryUnavailableError(fx.stream.streamId, { startPolicy: "earliest" }, 1, null);
    t.mock.method(fx.service, "applyStreamCompaction", async () => { throw nullBounds; });
    const response = await fx.post(`/streams/${fx.source.sourceId}/compaction-apply`, { apply: true, retentionMs: DAY });
    assert.equal(response.status, 409);
    assert.equal(response.data.highWatermarkOffset, null);
    assert.deepEqual(response.data.requested, { startPolicy: "earliest" });
  } finally { await fx.cleanup(); }
});

test("CLI defaults are read-only, apply is explicit, mode errors are 400 and remote 409 details survive", { timeout: 180_000 }, async (t) => {
  const fx = await fixture();
  try {
    const before = fx.snapshot();
    for (const args of [[], ["--dry-run", "--scan-limit", "1"]]) {
      const result = await fx.cli("--retention", "1d", ...args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).dryRun, true);
    }
    for (const args of [
      ["--apply", "--dry-run"], ["--apply", "--scan-limit", "1"],
      ["--batch-size", "1"], ["--max-events", "1"], ["--max-payload-bytes", "1"],
      ["--apply", "--batch-size", "101"], ["--apply", "--max-events", "1001"],
      ["--apply", "--max-payload-bytes", "8388609"], ["--apply", "--batch-size"],
    ]) {
      const result = await fx.cli("--retention", "1d", ...args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.equal(JSON.parse(result.stderr).statusCode, 400, result.stderr);
    }
    assert.deepEqual(fx.snapshot(), before);
    const applied = await fx.cli("--retention", "1d", "--apply", "--batch-size", "1",
      "--max-events", "1", "--max-payload-bytes", "8388608");
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).prunedEvents, 1);
    assert.equal(JSON.parse(applied.stdout).dryRun, false);
    const requested = { offset: 1 };
    t.mock.method(fx.service, "applyStreamCompaction", async () => {
      throw new HistoryUnavailableError(fx.stream.streamId, requested, 2, 2);
    });
    const rejected = await fx.cli("--retention", "1d", "--apply");
    assert.notEqual(rejected.code, 0);
    const details = JSON.parse(rejected.stderr);
    assert.equal(details.statusCode, 409);
    assert.equal(details.code, "history_unavailable");
    assert.equal(details.streamId, fx.stream.streamId);
    assert.deepEqual(details.requested, requested);
    assert.equal(details.retainedFromOffset, 2);
    assert.equal(details.highWatermarkOffset, 2);
  } finally { await fx.cleanup(); }
});
