import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";

async function makeAsyncService(): Promise<{ store: AgentInboxStore; service: AgentInboxService; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  const service = new AgentInboxService(store);
  return { store, service, dir };
}

test("shared source can route one event to multiple agent mailboxes", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const interestA = service.registerInterest({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
    });
    const interestB = service.registerInterest({
      agentId: "beta",
      sourceId: source.sourceId,
      matchRules: { channel: "engineering" },
    });

    const result = await service.emitItem({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: { channel: "engineering" },
      rawPayload: { text: "hello" },
    });

    assert.equal(result.inserted, 2);
    assert.equal(service.listMailboxItems(interestA.mailboxId).length, 1);
    assert.equal(service.listMailboxItems(interestB.mailboxId).length, 1);
    assert.equal(store.listActivations().length, 2);
    assert.equal(store.listSources().length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency prevents duplicate inserts for same mailbox and event identity", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const source = await service.registerSource({
      sourceType: "fixture",
      sourceKey: "demo",
      config: {},
    });
    const interest = service.registerInterest({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: {},
    });

    await service.emitItem({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });
    const second = await service.emitItem({
      sourceId: source.sourceId,
      sourceNativeId: "evt-1",
      eventVariant: "message.created",
      metadata: {},
      rawPayload: {},
    });

    assert.equal(second.inserted, 0);
    assert.equal(service.listMailboxItems(interest.mailboxId).length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delivery requests are recorded with provider metadata", async () => {
  const { store, service, dir } = await makeAsyncService();
  try {
    const result = await service.sendDelivery({
      provider: "fixture",
      surface: "chat",
      targetRef: "room-1",
      kind: "reply",
      payload: { text: "hello" },
    });
    assert.equal(result.status, "accepted");
    assert.equal(store.listDeliveries().length, 1);
    assert.equal(store.listDeliveries()[0].targetRef, "room-1");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
