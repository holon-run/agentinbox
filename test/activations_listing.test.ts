import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { AgentInboxStore } from "../src/store";
import type { Activation } from "../src/model";

function makeActivation(activationId: string, createdAt: string): Activation {
  return {
    kind: "agentinbox.activation",
    activationId,
    agentId: "agent_test",
    inboxId: "inbox_test",
    targetId: "target_test",
    targetKind: "webhook",
    subscriptionIds: [],
    sourceIds: [],
    latestEntryId: null,
    newEntryCount: 1,
    newItemCount: 1,
    summary: "test",
    createdAt,
    deliveredAt: null,
  };
}

test("listActivations returns created_at descending regardless of insert order, with and without limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-activations-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  try {
    // Deliberately insert with shuffled created_at values (and not in rowid
    // order) so the result cannot pass by relying on insertion order.
    const stamps = [
      "2026-11-08T00:00:00.000Z",
      "2026-11-10T00:00:00.000Z",
      "2026-11-07T00:00:00.000Z",
      "2026-11-09T00:00:00.000Z",
    ];
    stamps.forEach((stamp, index) => {
      store.insertActivation(makeActivation(`act_${index}`, stamp));
    });

    const unlimited = store.listActivations();
    assert.deepEqual(
      unlimited.map((activation) => activation.activationId),
      ["act_1", "act_3", "act_0", "act_2"],
    );

    const limited = store.listActivations(2);
    assert.deepEqual(
      limited.map((activation) => activation.activationId),
      ["act_1", "act_3"],
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("activations created_at index is used by the status listing query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-activations-idx-"));
  const dbPath = path.join(dir, "agentinbox.sqlite");
  const store = await AgentInboxStore.open(dbPath);
  try {
    const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    const plan = db.prepare("explain query plan select * from activations order by created_at desc limit ?")
      .all(10)
      .map((row) => String((row as Record<string, unknown>).detail));
    db.close();
    const planText = plan.join(" | ");
    assert.match(planText, /USING INDEX idx_activations_created_at/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
