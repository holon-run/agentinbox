import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { SqliteEventBusBackend, EnsureConsumerInput } from "../src/backend";
import { AppendSourceEventInput } from "../src/model";
import { AgentInboxStore } from "../src/store";
import {
  ApplyStreamCompactionInput,
  HistoryUnavailableError,
  compactionApplyOptions,
} from "../src/stream_compaction";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z";
const CUTOFF = new Date(NOW - DAY).toISOString();
const MIB = 1024 * 1024;
type Row = Record<string, unknown>;

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-apply-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  let store = await AgentInboxStore.open(dbPath);
  const db = new BetterSqlite3(dbPath);
  let backend = new SqliteEventBusBackend(store);
  t.after(() => {
    db.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const stream = await backend.ensureStream({ sourceId: "source", streamKey: "events", backend: "sqlite" });
  let sequence = 0;
  const append = (options: {
    streamId?: string;
    createdAt?: string;
    event?: Partial<AppendSourceEventInput>;
  } = {}) => {
    const event: AppendSourceEventInput = {
      sourceId: "source", sourceNativeId: `event-${++sequence}`, eventVariant: "test",
      occurredAt: "2099-01-01T00:00:00.000Z",
      metadata: { kind: "测试" }, rawPayload: { message: "中文秘密" },
      providerRawPayload: { secret: "provider" },
      deliveryHandle: { provider: "test", surface: "test", targetRef: "secret" },
      ...options.event,
    };
    const offset = store.insertStreamEvent(options.streamId ?? stream.streamId, event).lastOffset!;
    assert.ok(offset);
    db.prepare("update stream_events set created_at = ? where offset = ?").run(options.createdAt ?? OLD, offset);
    return { offset, event };
  };
  const consumer = (id: string, nextOffset: number, streamId = stream.streamId) => {
    store.insertConsumer({
      consumerId: id, streamId, subscriptionId: id, consumerKey: id, nextOffset,
      startPolicy: "at_offset", startOffset: nextOffset, startTime: null, createdAt: OLD, updatedAt: OLD,
    });
    return id;
  };
  const rows = (streamId = stream.streamId) =>
    db.prepare("select * from stream_events where stream_id = ? order by offset").all(streamId) as Row[];
  const snapshot = () => Object.fromEntries(
    (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>)
      .map(({ name }) => [name, db.prepare(`select * from "${name.replace(/"/g, '""')}"`).all()]),
  );
  const apply = (options: Partial<ApplyStreamCompactionInput> = {}) =>
    backend.applyStreamCompaction({ streamId: stream.streamId, retentionMs: DAY, ...options });
  const ensure = (startPolicy: EnsureConsumerInput["startPolicy"], options: Partial<EnsureConsumerInput> = {}) => {
    const id = `replay-${++sequence}`;
    return backend.ensureConsumer({
      streamId: stream.streamId, subscriptionId: id, consumerKey: id, startPolicy, ...options,
    });
  };
  return {
    db, stream, append, consumer, rows, snapshot, apply, ensure,
    get store() { return store; },
    get backend() { return backend; },
    async reopen() {
      store.close();
      store = await AgentInboxStore.open(dbPath);
      backend = new SqliteEventBusBackend(store);
    },
  };
}

function payloadBytes(row: Row) {
  const fields = {
    metadata: "metadata_json", rawPayload: "raw_payload_json",
    providerRawPayload: "provider_raw_payload_json", deliveryHandle: "delivery_handle_json",
  };
  const bytes = Object.fromEntries(Object.entries(fields).map(([name, column]) =>
    [name, row[column] == null ? 0 : Buffer.byteLength(String(row[column]))],
  ));
  return { ...bytes, total: Object.values(bytes).reduce((a, b) => a + b, 0) };
}

function identity(row: Row) {
  return Object.fromEntries([
    "offset", "stream_event_id", "stream_id", "source_id", "source_native_id",
    "event_variant", "occurred_at", "created_at",
  ].map((key) => [key, row[key]]));
}

function unavailable(streamId: string, retainedFromOffset: number, highWatermarkOffset: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HistoryUnavailableError);
    assert.equal(error.code, "history_unavailable");
    assert.equal(error.statusCode, 409);
    assert.equal(error.streamId, streamId);
    assert.equal(error.retainedFromOffset, retainedFromOffset);
    assert.equal(error.highWatermarkOffset, highWatermarkOffset);
    return true;
  };
}

test("apply preserves identity, dedup keys and historical high watermark while clearing all payload fields", async (t) => {
  const fx = await fixture(t);
  const first = fx.append();
  const last = fx.append({ event: { providerRawPayload: undefined, deliveryHandle: null } });
  fx.consumer("consumed", last.offset + 1);
  const before = fx.rows();
  const consumers = fx.db.prepare("select * from consumers").all();
  const result = await fx.apply();
  assert.equal(result.dryRun, false);
  assert.equal(result.cutoff, CUTOFF);
  assert.equal(result.prunedEvents, 2);
  const expectedBytes = before.map(payloadBytes);
  for (const [key, value] of Object.entries(result.prunedPayloadBytes)) {
    assert.equal(value, expectedBytes.reduce((total, bytes) => total + bytes[key as keyof typeof bytes], 0), key);
  }
  assert.equal(result.prunedThroughOffset, last.offset);
  assert.equal(result.retainedFromOffset, last.offset + 1);
  assert.equal(result.stopReason, "exhausted");
  assert.equal(result.hasMore, false);
  const after = fx.rows();
  assert.deepEqual(after.map(identity), before.map(identity));
  for (const row of after) {
    assert.equal(row.metadata_json, "{}");
    assert.equal(row.raw_payload_json, "{}");
    assert.equal(row.provider_raw_payload_json, null);
    assert.equal(row.delivery_handle_json, null);
    assert.equal(row.payload_pruned_at, new Date(NOW).toISOString());
  }
  assert.deepEqual(fx.db.prepare("select * from consumers").all(), consumers);
  assert.equal(fx.db.prepare("select count(*) as n from consumer_commits").get() &&
    (fx.db.prepare("select count(*) as n from consumer_commits").get() as { n: number }).n, 0);
  assert.deepEqual(await fx.backend.append({ streamId: fx.stream.streamId, events: [first.event, last.event] }),
    { appended: 0, deduped: 2, lastOffset: null });
  assert.deepEqual(fx.rows(), after, "dedup must neither restore payload nor mutate stubs");
  const stats = await fx.backend.getStreamStats(fx.stream.streamId);
  assert.equal(stats.eventCount, 2);
  assert.equal(stats.replayableEventCount, 0);
  assert.equal(stats.prunedEventCount, 2);
  assert.equal(stats.highWatermarkOffset, last.offset);
  const latest = await fx.ensure("latest");
  assert.equal(latest.nextOffset, last.offset + 1);
  assert.deepEqual((await fx.backend.read({ streamId: fx.stream.streamId, consumerId: latest.consumerId, limit: 10 })).events, []);
  const future = fx.append();
  assert.ok(future.offset > last.offset);
  const read = await fx.backend.read({ streamId: fx.stream.streamId, consumerId: latest.consumerId, limit: 10 });
  assert.deepEqual(read.events.map((event) => event.offset), [future.offset]);
  assert.deepEqual(read.events[0].rawPayload, future.event.rawPayload);
});

test("apply without consumers and on empty streams performs no business writes", async (t) => {
  const fx = await fixture(t);
  fx.append();
  const before = fx.snapshot();
  const result = await fx.apply();
  assert.equal(result.stopReason, "no_consumers");
  assert.equal(result.safeBeforeOffset, null);
  assert.equal(result.prunedEvents, 0);
  assert.equal(result.batches, 0);
  assert.deepEqual(fx.snapshot(), before);
  const empty = await fx.backend.ensureStream({ sourceId: "empty", streamKey: "empty", backend: "sqlite" });
  fx.consumer("empty", 1, empty.streamId);
  const emptyBefore = fx.snapshot();
  const exhausted = await fx.apply({ streamId: empty.streamId });
  assert.equal(exhausted.stopReason, "exhausted");
  assert.equal(exhausted.prunedEvents, 0);
  assert.equal(exhausted.batches, 0);
  assert.deepEqual(fx.snapshot(), emptyBefore);
});

test("minimum across all consumers protects offset=M, including offline and paused owners", async (t) => {
  const fx = await fixture(t);
  const first = fx.append().offset;
  const boundary = fx.append().offset;
  fx.append();
  fx.consumer("offline", boundary);
  fx.consumer("paused", boundary);
  fx.consumer("ahead", boundary + 100);
  // No runtime connection or subscription activity is needed to retain protection.
  const before = fx.rows();
  const result = await fx.apply();
  assert.equal(result.prunedEvents, 1);
  assert.equal(result.prunedThroughOffset, first);
  assert.equal(result.safeBeforeOffset, boundary);
  assert.equal(result.stopReason, "consumer_boundary");
  assert.deepEqual(result.blockingConsumers, [
    { consumerId: "offline", nextOffset: boundary }, { consumerId: "paused", nextOffset: boundary },
  ]);
  assert.deepEqual(fx.rows().slice(1), before.slice(1));
});

test("apply recomputes eligibility after preview rather than trusting its prior consumer boundary", async (t) => {
  const fx = await fixture(t);
  const first = fx.append().offset;
  const last = fx.append().offset;
  fx.consumer("ahead", last + 1);
  const preview = await fx.backend.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY });
  assert.equal(preview.candidateEvents, 2);
  fx.consumer("new-offline", first);
  const before = fx.snapshot();
  const result = await fx.apply();
  assert.equal(result.prunedEvents, 0);
  assert.equal(result.stopReason, "consumer_boundary");
  assert.equal(result.safeBeforeOffset, first);
  assert.deepEqual(fx.snapshot(), before);
});

test("created_at=cutoff stops the continuous stream prefix regardless of occurred_at and global offset holes", async (t) => {
  const fx = await fixture(t);
  const other = await fx.backend.ensureStream({ sourceId: "other", streamKey: "other", backend: "sqlite" });
  const first = fx.append({ event: { occurredAt: "2099-01-01T00:00:00.000Z" } }).offset;
  fx.append({ streamId: other.streamId });
  const second = fx.append({ event: { occurredAt: OLD } }).offset;
  const boundary = fx.append({ createdAt: CUTOFF, event: { occurredAt: "1990-01-01T00:00:00.000Z" } }).offset;
  fx.append({ event: { occurredAt: "1980-01-01T00:00:00.000Z" } });
  fx.consumer("ahead", boundary + 100);
  const before = fx.rows();
  const otherBefore = fx.rows(other.streamId);
  const result = await fx.apply({ batchSize: 1 });
  assert.equal(result.prunedEvents, 2);
  assert.equal(result.batches, 2);
  assert.equal(result.prunedThroughOffset, second);
  assert.equal(result.stopReason, "retention_boundary");
  assert.ok(second > first + 1);
  assert.deepEqual(fx.rows().slice(2), before.slice(2), "must not punch a hole after an unexpired row");
  assert.deepEqual(fx.rows(other.streamId), otherBefore);
});

test("default row budgets commit batches of 100 and cap each invocation at 1000 with resumable progress", async (t) => {
  const fx = await fixture(t);
  let last = 0;
  for (let i = 0; i < 1005; i++) last = fx.append().offset;
  fx.consumer("ahead", last + 1);
  const first = await fx.apply();
  assert.equal(first.prunedEvents, 1000);
  assert.equal(first.batches, 10);
  assert.equal(first.stopReason, "event_limit");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, Number(fx.rows()[1000].offset));
  const second = await fx.apply();
  assert.equal(second.prunedEvents, 5);
  assert.equal(second.batches, 1);
  assert.equal(second.prunedThroughOffset, last);
  assert.equal(second.stopReason, "exhausted");
  const before = fx.snapshot();
  const repeated = await fx.apply();
  assert.equal(repeated.prunedEvents, 0);
  assert.equal(repeated.prunedPayloadBytes.total, 0);
  assert.equal(repeated.batches, 0);
  assert.deepEqual(fx.snapshot(), before);
});

test("custom row limits stop at exactly maxEvents and smaller batchSize bounds each transaction", async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 8; i++) fx.append();
  fx.consumer("ahead", 100);
  const first = await fx.apply({ maxEvents: 5, batchSize: 2 });
  assert.equal(first.prunedEvents, 5);
  assert.equal(first.batches, 3);
  assert.equal(first.stopReason, "event_limit");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, Number(fx.rows()[5].offset));
  const second = await fx.apply({ maxEvents: 5, batchSize: 2 });
  assert.equal(second.prunedEvents, 3);
  assert.equal(second.batches, 2);
  assert.equal(second.hasMore, false);
});

test("default 8 MiB byte budget is per batch, not per invocation", async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 3; i++) fx.append({ event: { rawPayload: { value: "x".repeat(4 * MIB) } } });
  fx.consumer("ahead", 100);
  const expected = fx.rows().reduce((sum, row) => sum + payloadBytes(row).total, 0);
  const result = await fx.apply();
  assert.equal(result.prunedEvents, 3);
  assert.equal(result.batches, 3, "two 4 MiB-plus rows must never share an 8 MiB batch");
  assert.equal(result.prunedPayloadBytes.total, expected);
  assert.ok(result.prunedPayloadBytes.total > 8 * MIB);
});

test("exact UTF-8 byte budget is inclusive and the next row starts another bounded batch", async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 3; i++) fx.append();
  fx.consumer("ahead", 100);
  const bytes = payloadBytes(fx.rows()[0]).total;
  const result = await fx.apply({ maxPayloadBytes: bytes * 2 });
  assert.equal(result.prunedEvents, 3);
  assert.equal(result.batches, 2);
  assert.equal(result.prunedPayloadBytes.total, bytes * 3);
});

test("a single row exactly at the byte limit is eligible", async (t) => {
  const fx = await fixture(t);
  fx.append();
  fx.consumer("ahead", 100);
  const bytes = payloadBytes(fx.rows()[0]).total;
  const result = await fx.apply({ maxPayloadBytes: bytes });
  assert.equal(result.prunedEvents, 1);
  assert.equal(result.prunedPayloadBytes.total, bytes);
  assert.equal(result.hasMore, false);
});

test("oversized first row blocks later small rows and leaves all payloads untouched", async (t) => {
  const fx = await fixture(t);
  const oversized = fx.append({ event: { rawPayload: { value: "x".repeat(8 * MIB) } } }).offset;
  fx.append();
  fx.consumer("ahead", oversized + 100);
  const before = fx.snapshot();
  const result = await fx.apply();
  assert.equal(result.stopReason, "oversized");
  assert.equal(result.oversizedOffset, oversized);
  assert.equal(result.nextOffset, oversized);
  assert.equal(result.prunedEvents, 0);
  assert.equal(result.batches, 0);
  assert.equal(result.hasMore, true);
  assert.deepEqual(fx.snapshot(), before);
});

test("oversized row after a valid prefix commits only that prefix and prevents skipping ahead on reentry", async (t) => {
  const fx = await fixture(t);
  const first = fx.append().offset;
  const oversized = fx.append({ event: { rawPayload: { value: "x".repeat(512) } } }).offset;
  fx.append();
  fx.consumer("ahead", 100);
  const bytes = payloadBytes(fx.rows()[0]).total;
  const tail = fx.rows().slice(1);
  const result = await fx.apply({ maxPayloadBytes: bytes });
  assert.equal(result.prunedEvents, 1);
  assert.equal(result.prunedThroughOffset, first);
  assert.equal(result.stopReason, "oversized");
  assert.equal(result.oversizedOffset, oversized);
  assert.deepEqual(fx.rows().slice(1), tail);
  const before = fx.snapshot();
  assert.equal((await fx.apply({ maxPayloadBytes: bytes })).prunedEvents, 0);
  assert.deepEqual(fx.snapshot(), before);
});

test("all apply budgets have positive integer hard limits and invalid calls never write", async (t) => {
  const fx = await fixture(t);
  fx.append();
  fx.consumer("ahead", 100);
  const input = { streamId: fx.stream.streamId, retentionMs: DAY };
  const defaults = compactionApplyOptions(input, NOW);
  assert.deepEqual(defaults, { cutoff: CUTOFF, batchSize: 100, maxEvents: 1000, maxPayloadBytes: 8 * MIB });
  const before = fx.snapshot();
  for (const [key, maximum] of [
    ["batchSize", 100], ["maxEvents", 1000], ["maxPayloadBytes", 8 * MIB],
  ] as const) {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, maximum + 1, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(fx.apply({ [key]: invalid }), { statusCode: 400 }, `${key}=${invalid}`);
    }
  }
  for (const retentionMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(fx.apply({ retentionMs }), { statusCode: 400 });
  }
  await assert.rejects(fx.apply({ streamId: "missing" }), /unknown stream/);
  assert.deepEqual(fx.snapshot(), before);
});

test("preview after apply ignores identity stubs, remains read-only, and estimates only the remaining prefix", async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 4; i++) fx.append();
  fx.consumer("ahead", 100);
  await fx.apply({ maxEvents: 2 });
  const retained = fx.rows().slice(2);
  const before = fx.snapshot();
  const dataVersion = fx.db.pragma("data_version", { simple: true });
  const result = await fx.backend.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY });
  assert.equal(result.scannedEvents, 2);
  assert.equal(result.candidateEvents, 2);
  assert.equal(result.candidateThroughOffset, Number(retained[1].offset));
  assert.equal(result.candidatePayloadBytes.total, retained.reduce((sum, row) => sum + payloadBytes(row).total, 0));
  assert.equal(result.scannedPayloadBytes.total, result.candidatePayloadBytes.total);
  assert.deepEqual(fx.snapshot(), before);
  assert.equal(fx.db.pragma("data_version", { simple: true }), dataVersion);
  await fx.apply();
  const emptyBefore = fx.snapshot();
  const empty = await fx.backend.previewStreamCompaction({ streamId: fx.stream.streamId, retentionMs: DAY });
  assert.equal(empty.scannedEvents, 0);
  assert.equal(empty.candidateEvents, 0);
  assert.equal(empty.scannedPayloadBytes.total, 0);
  assert.equal(empty.projectedRetainedFromOffset, Number(retained[1].offset) + 1);
  assert.deepEqual(fx.snapshot(), emptyBefore);
});

test("SQLite ABORT on the second update rolls back the entire first batch", async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 4; i++) fx.append();
  fx.consumer("ahead", 100);
  fx.db.exec(`
    create trigger fail_compaction before update of payload_pruned_at on stream_events
    when new.payload_pruned_at is not null
    begin
      select case when (select count(*) from stream_events where payload_pruned_at is not null) = 1
        then raise(abort, 'compaction batch interrupted') end;
    end;
  `);
  const before = fx.snapshot();
  await assert.rejects(fx.apply({ batchSize: 3 }), /compaction batch interrupted/);
  assert.deepEqual(fx.snapshot(), before, "the first update in the failed transaction must also roll back");
  fx.db.exec("drop trigger fail_compaction");
  assert.equal((await fx.apply({ batchSize: 3 })).prunedEvents, 4);
});

test("a failed later batch preserves prior commits; reopen and reentry finish without rewriting old stubs", async (t) => {
  const fx = await fixture(t);
  for (let i = 0; i < 7; i++) fx.append();
  fx.consumer("ahead", 100);
  const original = fx.rows();
  fx.db.exec(`
    create trigger fail_compaction before update of payload_pruned_at on stream_events
    when new.payload_pruned_at is not null
    begin
      select case when (select count(*) from stream_events where payload_pruned_at is not null) = 4
        then raise(abort, 'later batch interrupted') end;
    end;
  `);
  await assert.rejects(fx.apply({ batchSize: 3 }), /later batch interrupted/);
  const interrupted = fx.rows();
  assert.equal(interrupted.filter((row) => row.payload_pruned_at != null).length, 3);
  assert.deepEqual(interrupted.slice(3), original.slice(3));
  fx.db.exec("drop trigger fail_compaction");
  await fx.reopen();
  assert.deepEqual(fx.rows(), interrupted);
  const resumed = await fx.apply({ batchSize: 3 });
  assert.equal(resumed.prunedEvents, 4);
  assert.equal(resumed.batches, 2);
  assert.deepEqual(fx.rows().slice(0, 3), interrupted.slice(0, 3));
  assert.deepEqual(fx.rows().map(identity), original.map(identity));
  const before = fx.snapshot();
  assert.equal((await fx.apply()).prunedEvents, 0);
  assert.deepEqual(fx.snapshot(), before);
});

test("earliest, at_offset, reset, commit and read explicitly reject unavailable history without writes", async (t) => {
  const fx = await fixture(t);
  const first = fx.append().offset;
  const prunedThrough = fx.append().offset;
  const retained = fx.append().offset;
  const id = fx.consumer("consumer", retained);
  await fx.apply();
  const check = unavailable(fx.stream.streamId, prunedThrough + 1, retained);
  const before = fx.snapshot();
  await assert.rejects(fx.ensure("earliest"), check);
  await assert.rejects(fx.ensure("at_offset", { startOffset: first }), check);
  await assert.rejects(fx.backend.reset({ consumerId: id, startPolicy: "earliest" }), check);
  await assert.rejects(fx.backend.reset({ consumerId: id, startPolicy: "at_offset", startOffset: prunedThrough }), check);
  await assert.rejects(fx.backend.commit({ consumerId: id, committedOffset: first - 1 }), check);
  assert.throws(() => fx.store.readStreamEvents(fx.stream.streamId, first, 10), check);
  assert.deepEqual(fx.snapshot(), before, "failed guard calls must not insert consumers or commit records");
  const accepted = await fx.ensure("at_offset", { startOffset: prunedThrough + 1 });
  const read = await fx.backend.read({ streamId: fx.stream.streamId, consumerId: accepted.consumerId, limit: 10 });
  assert.deepEqual(read.events.map((event) => event.offset), [retained]);
  assert.notDeepEqual(read.events[0].rawPayload, {});
  const committed = await fx.backend.commit({ consumerId: id, committedOffset: prunedThrough });
  assert.equal(committed.consumer.nextOffset, retained, "committing up to the last pruned event is safe");
  assert.equal((await fx.backend.reset({ consumerId: id, startPolicy: "latest" })).nextOffset, retained + 1);
  // Emulate legacy/corrupt persisted state to verify backend read does not silently skip stubs.
  fx.db.prepare("update consumers set next_offset = ? where consumer_id = ?").run(first, id);
  const invalidBefore = fx.snapshot();
  await assert.rejects(fx.backend.read({ streamId: fx.stream.streamId, consumerId: id, limit: 10 }), check);
  assert.deepEqual(fx.snapshot(), invalidBefore);
  const lag = await fx.backend.getConsumerLag({ consumerId: id });
  assert.equal(lag.pendingEvents, 1, "lag counts retained events only, even for an old persisted cursor");
  assert.equal(lag.highWatermarkOffset, retained);
});

test("at_offset at the retained bound accepts global holes and returns only real retained events", async (t) => {
  const fx = await fixture(t);
  const first = fx.append().offset;
  const other = await fx.backend.ensureStream({ sourceId: "other", streamKey: "other", backend: "sqlite" });
  fx.append({ streamId: other.streamId });
  const retained = fx.append().offset;
  fx.consumer("consumer", retained);
  await fx.apply();
  assert.ok(retained > first + 1);
  const consumer = await fx.ensure("at_offset", { startOffset: first + 1 });
  assert.equal(consumer.nextOffset, first + 1);
  const result = await fx.backend.read({ streamId: fx.stream.streamId, consumerId: consumer.consumerId, limit: 10 });
  assert.deepEqual(result.events.map((event) => event.offset), [retained]);
  const reset = await fx.backend.reset({ consumerId: consumer.consumerId, startPolicy: "at_offset", startOffset: first + 1 });
  assert.equal(reset.nextOffset, first + 1);
});

test("at_time checks pruned occurred_at>=request, including equality and out-of-order times, not created_at cutoff", async (t) => {
  const fx = await fixture(t);
  fx.append({ event: { occurredAt: "2099-01-01T00:00:00.000Z" } });
  const prunedThrough = fx.append({ event: { occurredAt: "2000-01-01T00:00:00.000Z" } }).offset;
  const retained = fx.append({ event: { occurredAt: "2101-01-01T00:00:00.000Z" } }).offset;
  const id = fx.consumer("consumer", retained);
  await fx.apply();
  const check = unavailable(fx.stream.streamId, prunedThrough + 1, retained);
  for (const startTime of [OLD, CUTOFF, "2099-01-01T00:00:00.000Z"]) {
    const before = fx.snapshot();
    await assert.rejects(fx.ensure("at_time", { startTime }), (error: unknown) => {
      check(error);
      assert.equal((error as HistoryUnavailableError).requested.time, startTime);
      return true;
    });
    await assert.rejects(fx.backend.reset({ consumerId: id, startPolicy: "at_time", startTime }), check);
    assert.deepEqual(fx.snapshot(), before);
  }
  const consumer = await fx.ensure("at_time", { startTime: "2100-01-01T00:00:00.000Z" });
  assert.equal(consumer.nextOffset, retained);
  assert.deepEqual((await fx.backend.read({ streamId: fx.stream.streamId, consumerId: consumer.consumerId, limit: 10 }))
    .events.map((event) => event.offset), [retained]);
  const future = await fx.ensure("at_time", { startTime: "2200-01-01T00:00:00.000Z" });
  assert.equal(future.nextOffset, retained + 1);
});

test("direct store consumer insert/reset/commit cannot bypass historical boundaries", async (t) => {
  const fx = await fixture(t);
  const first = fx.append().offset;
  const retained = fx.append().offset;
  const id = fx.consumer("consumer", retained);
  await fx.apply();
  const check = unavailable(fx.stream.streamId, first + 1, retained);
  const before = fx.snapshot();
  assert.throws(() => fx.consumer("backdated", first), check);
  assert.throws(() => fx.store.updateConsumerOffset(id, first, first - 1), check);
  assert.throws(() => fx.store.resetConsumer(id, {
    nextOffset: first, startPolicy: "at_offset", startOffset: first, startTime: null,
  }), check);
  assert.throws(() => fx.store.resetConsumer(id, {
    nextOffset: retained, startPolicy: "earliest", startOffset: null, startTime: null,
  }), check);
  assert.throws(() => fx.store.resetConsumer(id, {
    nextOffset: retained, startPolicy: "at_time", startOffset: null, startTime: OLD,
  }), check);
  assert.deepEqual(fx.snapshot(), before);
});
