import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentInboxStore } from "../src/store";
import { AgentInboxService } from "../src/service";
import { AdapterRegistry } from "../src/adapters";
import { AppendSourceEventInput, DeliveryAttempt, SubscriptionSource } from "../src/model";
import { nowIso } from "../src/util";
import {
  FeishuDeliveryAdapter,
  FeishuSourceRuntime,
  FeishuUxcClient,
  type FeishuUxcLikeClient,
  normalizeFeishuBotEvent,
} from "../src/sources/feishu";

const FEISHU_IM_SCHEMA_URL =
  "https://raw.githubusercontent.com/holon-run/uxc/main/skills/feishu-openapi-skill/references/feishu-im.openapi.json";

class FakeFeishuUxcClient implements FeishuUxcLikeClient {
  public started: Array<Record<string, unknown>> = [];
  public calls: Array<Record<string, unknown>> = [];
  public jobs = new Map<string, { status: string; events: Array<{ event_kind: string; data?: unknown }> }>();

  async subscribeStart(args: Record<string, unknown>) {
    this.started.push(args);
    const jobId = `job-${this.started.length}`;
    this.jobs.set(jobId, { status: "running", events: [] });
    return {
      job_id: jobId,
      mode: "stream" as const,
      protocol: "feishu_long_connection",
      endpoint: "https://open.feishu.cn/open-apis",
      sink: "memory:",
      status: "running",
    };
  }

  async subscribeStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("missing job");
    }
    return { status: job.status };
  }

  async subscriptionEvents(args: { jobId: string; afterSeq?: number }) {
    const job = this.jobs.get(args.jobId);
    if (!job) {
      throw new Error("missing job");
    }
    const events = job.events;
    job.events = [];
    return {
      status: job.status,
      events: events.map((event, index) => ({
        version: "v1",
        job_id: args.jobId,
        seq: (args.afterSeq ?? 0) + index + 1,
        timestamp_unix: Date.now(),
        protocol: "feishu_long_connection",
        source_kind: "feishu_long_connection",
        event_kind: event.event_kind,
        data: event.data,
        meta: {},
      })),
      next_after_seq: (args.afterSeq ?? 0) + events.length,
      has_more: false,
    };
  }

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    return { data: { ok: true } };
  }
}

async function makeService(): Promise<{ store: AgentInboxStore; service: AgentInboxService; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentinbox-feishu-test-"));
  const store = await AgentInboxStore.open(path.join(dir, "agentinbox.sqlite"));
  let service: AgentInboxService;
  const adapters = new AdapterRegistry(store, async (input: AppendSourceEventInput) => service.appendSourceEvent(input));
  service = new AgentInboxService(store, adapters);
  return { store, service, dir };
}

test("normalizeFeishuBotEvent extracts metadata and delivery handle", () => {
  const source: SubscriptionSource = {
    sourceId: "src_feishu",
    sourceType: "feishu_bot",
    sourceKey: "tenant-default",
    configRef: null,
    config: { uxcAuth: "feishu-default" },
    status: "active",
    checkpoint: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const normalized = normalizeFeishuBotEvent(source, { uxcAuth: "feishu-default" }, {
    header: {
      event_id: "fevt_1",
      event_type: "im.message.receive_v1",
      create_time: "1773491924409",
    },
    event: {
      message: {
        message_id: "om_123",
        chat_id: "oc_456",
        chat_type: "group",
        message_type: "text",
        content: "{\"text\":\"Hello @Alpha\"}",
        create_time: "1773491924409",
        mentions: [{ key: "@_user_1", name: "Alpha", id: { open_id: "ou_alpha" } }],
      },
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: "user",
      },
    },
  });

  assert.ok(normalized);
  assert.equal(normalized.eventVariant, "im.message.receive_v1.text");
  assert.equal(normalized.metadata?.chatId, "oc_456");
  assert.deepEqual(normalized.metadata?.mentions, ["Alpha"]);
  assert.deepEqual(normalized.metadata?.mentionOpenIds, ["ou_alpha"]);
  assert.equal(normalized.metadata?.content, "Hello @Alpha");
  assert.equal(normalized.deliveryHandle?.provider, "feishu");
  assert.equal(normalized.deliveryHandle?.surface, "message_reply");
  assert.equal(normalized.deliveryHandle?.targetRef, "om_123");
});

test("feishu source runtime appends stream events and subscriptions materialize inbox items", async () => {
  const { store, service, dir } = await makeService();
  try {
    const fake = new FakeFeishuUxcClient();
    const runtime = new FeishuSourceRuntime(store, async (input) => service.appendSourceEvent(input), new FeishuUxcClient(fake));
    const source: SubscriptionSource = {
      sourceId: "src_feishu",
      sourceType: "feishu_bot",
      sourceKey: "tenant-default",
      configRef: null,
      config: { uxcAuth: "feishu-default" },
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.insertSource(source);
    const subscription = await service.registerSubscription({
      agentId: "alpha",
      sourceId: source.sourceId,
      matchRules: { mentions: ["Alpha"] },
      startPolicy: "earliest",
    });

    await runtime.ensureSource(source);
    const checkpoint = JSON.parse(store.getSource(source.sourceId)?.checkpoint ?? "{}") as { uxcJobId: string };
    fake.jobs.get(checkpoint.uxcJobId)?.events.push({
      event_kind: "data",
      data: {
        header: {
          event_id: "fevt_2",
          event_type: "im.message.receive_v1",
          create_time: "1773491924409",
        },
        event: {
          message: {
            message_id: "om_2",
            chat_id: "oc_team",
            chat_type: "group",
            message_type: "text",
            content: "{\"text\":\"hello from Alpha\"}",
            create_time: "1773491924409",
            mentions: [{ key: "@_user_1", name: "Alpha", id: { open_id: "ou_alpha" } }],
          },
          sender: {
            sender_id: { open_id: "ou_sender" },
            sender_type: "user",
          },
        },
      },
    });

    const sourceResult = await runtime.pollSource(source.sourceId);
    const subscriptionResult = await service.pollSubscription(subscription.subscriptionId);
    assert.equal(sourceResult.appended, 1);
    assert.equal(subscriptionResult.inboxItemsCreated, 1);
    assert.equal(service.listInboxItems(subscription.inboxId).length, 1);
    assert.equal(service.listInboxItems(subscription.inboxId)[0]?.deliveryHandle?.surface, "message_reply");
  } finally {
    await service.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("feishu delivery adapter maps message replies and chat sends to uxc calls", async () => {
  const fake = new FakeFeishuUxcClient();
  const adapter = new FeishuDeliveryAdapter(new FeishuUxcClient(fake));

  const replyAttempt: DeliveryAttempt = {
    deliveryId: "dlv_1",
    provider: "feishu",
    surface: "message_reply",
    targetRef: "om_reply",
    threadRef: null,
    replyMode: "reply",
    kind: "reply",
    payload: { text: "hello" },
    status: "accepted",
    createdAt: nowIso(),
  };
  await adapter.send({ kind: "reply", payload: { text: "hello" } } as never, replyAttempt);
  assert.equal(fake.calls[0]?.operation, "post:/im/v1/messages/{message_id}/reply");
  assert.equal((fake.calls[0]?.options as Record<string, unknown>)?.schema_url, FEISHU_IM_SCHEMA_URL);

  const chatAttempt: DeliveryAttempt = {
    ...replyAttempt,
    deliveryId: "dlv_2",
    surface: "chat_message",
    targetRef: "oc_chat",
    replyMode: null,
  };
  await adapter.send({ kind: "notify", payload: { text: "team update" } } as never, chatAttempt);
  assert.equal(fake.calls[1]?.operation, "post:/im/v1/messages");
  assert.equal((fake.calls[1]?.payload as Record<string, unknown>)?.receive_id_type, "chat_id");
  assert.equal((fake.calls[1]?.options as Record<string, unknown>)?.schema_url, FEISHU_IM_SCHEMA_URL);
});
