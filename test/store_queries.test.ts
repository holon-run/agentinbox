import test from "node:test";
import assert from "node:assert/strict";
import { buildSubscriptionListQuery } from "../src/store_queries";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { AgentInboxStore } from "../src/store";
import { InboxItem } from "../src/model";

test("buildSubscriptionListQuery keeps default subscription ordering", () => {
  assert.deepEqual(buildSubscriptionListQuery(), {
    sql: "select * from subscriptions order by created_at asc, subscription_id asc",
    params: [],
  });
});

// Digest pending and notification state (core store contract).
async function makeDigestStoreFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-digest-store-"));
  const dbPath = path.join(dir, "inbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  const now = "2026-10-14T00:00:00.000Z";
  store.insertAgent({
    agentId: "digest-agent", runtimeKind: "unknown", status: "active",
    createdAt: now, updatedAt: now, lastSeenAt: now,
  });
  store.insertInbox({ inboxId: "digest-inbox", ownerAgentId: "digest-agent", createdAt: now });
  const createThread = (groupKey = "group") => store.createDigestThread({
    inboxId: "digest-inbox", sourceId: "digest-source", groupKey, summary: "updates",
    firstItemAt: now, flushAfterAt: "2026-10-14T00:01:00.000Z", createdAt: now,
  });
  const thread = createThread();
  const append = (itemId: string, threadId = thread.threadId) => {
    const item: InboxItem = {
      itemId, inboxId: "digest-inbox", sourceId: "digest-source", sourceNativeId: itemId,
      eventVariant: "updated", occurredAt: now, metadata: {}, rawPayload: {},
      deliveryHandle: null, ackedAt: null,
    };
    store.insertInboxItem(item);
    store.addItemToDigestThread(threadId, itemId, now, "updates", "2026-10-14T00:01:00.000Z");
  };
  const snapshot = (itemIds: string[], notificationState?: Record<string, unknown>) =>
    store.materializeDigestSnapshot({
      threadId: thread.threadId, inboxId: "digest-inbox", groupKey: thread.groupKey,
      summary: "published", sourceIds: ["digest-source"], subscriptionIds: [],
      itemIds, firstItemAt: now, lastItemAt: now, createdAt: now, notificationState,
    });
  return { dir, dbPath, store, thread, now, createThread, append, snapshot };
}

test("digest pending and notification state: snapshot history, ack, GC and reopen preserve pending", async () => {
  const fx = await makeDigestStoreFixture();
  let store = fx.store;
  try {
    fx.append("one");
    fx.append("two");
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 2);
    const first = fx.snapshot(["one", "two"]);
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 0);
    fx.append("three");
    // Duplicate attachment and deliberately old occurredAt must not change membership semantics.
    store.addItemToDigestThread(fx.thread.threadId, "three", "2000-01-01T00:00:00.000Z", "updates", fx.now);
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 1);
    store.ackItems("digest-inbox", ["one"], fx.now);
    fx.snapshot(["two"]); // Ack repair excludes pending "three".
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 1);
    assert.deepEqual(store.listSnapshottedUnackedInboxItemsForDigestThread(fx.thread.threadId).map((item) => item.itemId), ["two"]);
    assert.ok(store.getInboxEntry(first.entryId)!.supersededAt);
    assert.ok(store.getDigestThread(fx.thread.threadId)!.flushAfterAt, "repair must preserve a pending deadline");
    store.deleteAckedInboxItems("digest-inbox", "2026-10-15T00:00:00.000Z");
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 1, "GC must retain superseded associations to unacked items");
    const other = fx.createThread("other");
    fx.append("four", other.threadId);
    assert.equal(store.countPendingInboxItemsForDigestThread(other.threadId), 1);
    store.close();
    store = await AgentInboxStore.open(fx.dbPath);
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 1);
    assert.equal(store.countPendingInboxItemsForDigestThread(other.threadId), 1);
    store.ackItems("digest-inbox", ["three"], fx.now);
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 0);
  } finally {
    store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("digest pending and notification state: opaque state survives rotation/ack/reopen and cascades on inbox deletion", async () => {
  const fx = await makeDigestStoreFixture();
  let store = fx.store;
  try {
    assert.equal(store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), null);
    fx.append("one");
    const state = { generation: 1, opaque: { stage: "reported", fingerprint: ["a", 7] } };
    fx.snapshot(["one"], state);
    assert.deepEqual(store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), state);
    store.ackItems("digest-inbox", ["one"], fx.now);
    store.deleteAckedInboxItems("digest-inbox", "2026-10-15T00:00:00.000Z");
    store.closeDigestThread(fx.thread.threadId, fx.now);
    fx.createThread();
    assert.deepEqual(store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), state);
    store.close();
    store = await AgentInboxStore.open(fx.dbPath);
    assert.deepEqual(store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), state);
    store.deleteAgent("digest-agent");
    assert.equal(store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), null);
  } finally {
    store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("digest pending and notification state: snapshot and state roll back atomically", async () => {
  const fx = await makeDigestStoreFixture();
  try {
    fx.append("one");
    fx.store.storeDigestNotificationState("digest-inbox", fx.thread.groupKey, { generation: 0 });
    const db = new BetterSqlite3(fx.dbPath);
    try {
      db.exec(`create trigger reject_digest_commit before update on digest_threads
        begin select raise(abort, 'test snapshot failure'); end`);
      assert.throws(() => fx.snapshot(["one"], { generation: 1 }), /test snapshot failure/);
      assert.equal(fx.store.getDigestThread(fx.thread.threadId)!.latestRevision, 0);
      assert.equal(fx.store.listInboxEntries("digest-inbox", { includeAcked: true }).length, 0);
      assert.deepEqual(fx.store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), { generation: 0 });
      assert.equal(fx.store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 1);
      db.exec("drop trigger reject_digest_commit");
      fx.snapshot(["one"], { generation: 1 });
      assert.deepEqual(fx.store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), { generation: 1 });
    } finally {
      db.close();
    }
  } finally {
    fx.store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("buildSubscriptionListQuery applies filters before limit", () => {
  assert.deepEqual(buildSubscriptionListQuery({ sourceId: "src_1", agentId: "agent_1", limit: 10 }), {
    sql: "select * from subscriptions where source_id = ? and agent_id = ? order by created_at asc, subscription_id asc limit ?",
    params: ["src_1", "agent_1", 10],
  });
});

test("digest pending and notification state: pending query uses indexed membership lookups", async () => {
  const fx = await makeDigestStoreFixture();
  try {
    fx.append("one");
    let query = "";
    let params: unknown[] = [];
    const internal = fx.store as any;
    const getOne = internal.getOne.bind(fx.store);
    internal.getOne = (sql: string, bindings: unknown[]) => {
      query = sql;
      params = bindings;
      return getOne(sql, bindings);
    };
    assert.equal(fx.store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 1);
    internal.getOne = getOne;
    const plan = internal.db.prepare(`explain query plan ${query}`).all(...params)
      .map((row: { detail: string }) => row.detail) as string[];
    assert.ok(plan.some((detail) => /SEARCH t .*thread_id/.test(detail)), plan.join("\n"));
    assert.ok(plan.some((detail) => /SEARCH ei .*item_id/.test(detail)), plan.join("\n"));
    assert.ok(plan.every((detail) => !/^SCAN /.test(detail)), plan.join("\n"));
  } finally {
    fx.store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("digest pending and notification state: existing databases migrate with empty state and preserve snapshots", async () => {
  const fx = await makeDigestStoreFixture();
  let store = fx.store;
  let closed = false;
  try {
    fx.append("one");
    const entry = fx.snapshot(["one"]);
    store.close();
    closed = true;
    const db = new BetterSqlite3(fx.dbPath);
    try {
      db.exec("drop table digest_notification_states");
      db.prepare("delete from __drizzle_migrations where tag = ?").run("0010_digest_notification_states");
      db.pragma("user_version = 10");
    } finally {
      db.close();
    }
    store = await AgentInboxStore.open(fx.dbPath);
    closed = false;
    assert.equal(store.getDigestNotificationState("digest-inbox", fx.thread.groupKey), null);
    assert.deepEqual(store.getInboxEntry(entry.entryId)!.itemIds, ["one"]);
    assert.equal(store.countPendingInboxItemsForDigestThread(fx.thread.threadId), 0);
  } finally {
    if (!closed) store.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
