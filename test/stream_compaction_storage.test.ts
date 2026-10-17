import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { AgentInboxStore } from "../src/store";
import { SqliteEventBusBackend } from "../src/backend";

test("compaction migration only adds nullable identity markers/indexes and preserves historical payloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-migration-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  let store: AgentInboxStore | undefined;
  const db = new BetterSqlite3(dbPath);
  try {
    const migrations = path.resolve(__dirname, "../drizzle/migrations");
    db.exec(`create table __drizzle_migrations (
      id integer primary key autoincrement, tag text not null unique, applied_at text not null
    )`);
    for (const file of fs.readdirSync(migrations).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      if (file.startsWith("0013_")) break;
      db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
      db.prepare("insert into __drizzle_migrations (tag, applied_at) values (?, ?)")
        .run(file.slice(0, -4), "2026-10-01T00:00:00.000Z");
    }
    db.prepare(`insert into streams (stream_id, source_id, stream_key, backend, created_at)
      values ('str_migration', 'source', 'events', 'sqlite', '2026-01-01')`).run();
    db.prepare(`insert into stream_events (
      stream_event_id, stream_id, source_id, source_native_id, event_variant, occurred_at,
      metadata_json, raw_payload_json, provider_raw_payload_json, delivery_handle_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "sev_migration", "str_migration", "source", "original", "test", "2099-01-01",
      '{"type":"test"}', '{"secret":"原始负载"}', '{"opaque":"original"}', '{"route":"original"}', "2000-01-01",
    );
    const before = db.prepare("select * from stream_events").get();
    store = await AgentInboxStore.open(dbPath);
    const after = db.prepare("select * from stream_events").get() as Record<string, unknown>;
    assert.equal(after.payload_pruned_at, null);
    const { payload_pruned_at: _marker, ...originalColumns } = after;
    assert.deepEqual(originalColumns, before);
    assert.equal(store.getStreamStats("str_migration").prunedEventCount, 0);
    assert.equal(store.readStreamEvents("str_migration", 1, 10)[0].rawPayload.secret, "原始负载");
    const backup = new BetterSqlite3(`${dbPath}.pre-migrate-v14.bak`, { readonly: true });
    try {
      assert.deepEqual(backup.prepare("select * from stream_events").get(), before);
      assert.equal((backup.prepare("pragma table_info(stream_events)").all() as Array<{ name: string }>)
        .some((column) => column.name === "payload_pruned_at"), false);
    } finally { backup.close(); }
    const snapshot = db.prepare("select * from stream_events").all();
    store.close();
    store = await AgentInboxStore.open(dbPath);
    assert.deepEqual(db.prepare("select * from stream_events").all(), snapshot);
  } finally {
    store?.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history/retained-prefix queries use partial indexes and normal backend reads do not count all history", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-query-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const db = new BetterSqlite3(dbPath);
  try {
    const backend = new SqliteEventBusBackend(store);
    const stream = await backend.ensureStream({ sourceId: "source", streamKey: "events", backend: "sqlite" });
    const { consumerId } = await backend.ensureConsumer({
      streamId: stream.streamId, consumerKey: "reader", subscriptionId: "reader", startPolicy: "earliest",
    });
    store.insertStreamEvent(stream.streamId, {
      sourceId: "source", sourceNativeId: "event", eventVariant: "test", metadata: {}, rawPayload: {},
    });
    const plans: Array<[string, unknown[], string]> = [
      [`select offset from stream_events where stream_id = ? and payload_pruned_at is not null
        order by offset desc limit 1`, [stream.streamId], "idx_stream_events_pruned_offset"],
      [`select * from stream_events where stream_id = ? and offset >= ? and payload_pruned_at is null
        order by offset limit ?`, [stream.streamId, 1, 100], "idx_stream_events_retained_offset"],
      [`select offset, length(cast(raw_payload_json as blob)) from stream_events
        where stream_id = ? and payload_pruned_at is null order by offset limit ?`,
      [stream.streamId, 101], "idx_stream_events_retained_offset"],
      [`select offset from stream_events where stream_id = ? and payload_pruned_at is not null
        and occurred_at >= ? limit 1`, [stream.streamId, "2026-01-01"], "idx_stream_events_pruned_occurred_at"],
      ["select min(next_offset) from consumers where stream_id = ?", [stream.streamId], "idx_consumers_stream_next_offset"],
    ];
    for (const [query, params, index] of plans) {
      const plan = db.prepare(`explain query plan ${query}`).all(...params) as Array<{ detail: string }>;
      assert.ok(plan.some((row) => row.detail.includes(index)), `${index}: ${JSON.stringify(plan)}`);
      assert.ok(plan.every((row) => !row.detail.includes("SCAN stream_events")), JSON.stringify(plan));
    }
    t.mock.method(store, "getStreamStats", () => { throw new Error("normal reads must not scan/count history"); });
    assert.equal((await backend.read({ streamId: stream.streamId, consumerId, limit: 10 })).events.length, 1);
    assert.equal((await backend.getConsumerLag({ consumerId })).pendingEvents, 1);
    assert.equal((await backend.ensureConsumer({
      streamId: stream.streamId, consumerKey: "latest", subscriptionId: "latest", startPolicy: "latest",
    })).nextOffset, 2);
  } finally {
    db.close(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("synthetic large payloads shrink logical storage in bounded short transactions", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-compaction-bytes-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const db = new BetterSqlite3(dbPath);
  try {
    const backend = new SqliteEventBusBackend(store);
    const stream = await backend.ensureStream({ sourceId: "large", streamKey: "events", backend: "sqlite" });
    const payload = { value: "负".repeat(44_000) };
    const insert = db.prepare(`insert into stream_events (
      stream_event_id, stream_id, source_id, source_native_id, event_variant, occurred_at,
      metadata_json, raw_payload_json, provider_raw_payload_json, delivery_handle_json, created_at
    ) values (?, ?, 'large', ?, 'test', '2099-01-01', '{}', ?, null, null, '2000-01-01')`);
    db.transaction(() => {
      for (let i = 0; i < 160; i++) insert.run(`sev_${i}`, stream.streamId, `native-${i}`, JSON.stringify(payload));
    })();
    await backend.ensureConsumer({
      streamId: stream.streamId, consumerKey: "latest", subscriptionId: "latest", startPolicy: "latest",
    });
    const logicalBytes = () => Number((db.prepare(`select
      sum(length(cast(metadata_json as blob)) + length(cast(raw_payload_json as blob))) as n
      from stream_events`).get() as { n: number }).n);
    const before = logicalBytes();
    // Observe the actual synchronous SQLite transactions; do not impose a
    // machine-dependent wall-clock threshold on CI.
    const transactions = store as unknown as {
      inTransaction<T>(fn: () => T, mode?: "deferred" | "immediate"): T;
    };
    const original = transactions.inTransaction.bind(store);
    const samples: Array<{ elapsedMs: number; sourceBytes: number }> = [];
    t.mock.method(transactions, "inTransaction", <T>(fn: () => T, mode?: "deferred" | "immediate") => {
      const bytesBefore = logicalBytes();
      const start = performance.now();
      const value = original(fn, mode);
      const elapsedMs = performance.now() - start;
      if (mode === "immediate") {
        const after = logicalBytes();
        const prunedRows = (bytesBefore - after) / (Buffer.byteLength(JSON.stringify(payload)) - 2);
        samples.push({ elapsedMs, sourceBytes: bytesBefore - after + prunedRows * 4 });
      }
      return value;
    });
    const result = await backend.applyStreamCompaction({ streamId: stream.streamId, retentionMs: 86_400_000 });
    const after = logicalBytes();
    assert.equal(result.prunedEvents, 160);
    assert.equal(result.batches, 3);
    assert.equal(result.prunedPayloadBytes.total, before);
    assert.equal(after, 160 * 4); // Required metadata/raw "{}" identity placeholders.
    assert.ok(samples.every((sample) => sample.sourceBytes <= 8 * 1024 * 1024));
    assert.ok(Number(db.pragma("freelist_count", { simple: true })) > 0);
    t.diagnostic(JSON.stringify({ logicalBytesBefore: before, logicalBytesAfter: after, batches: samples }));
  } finally {
    db.close(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
