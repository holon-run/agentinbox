import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryAttempt, SourceStream } from "../src/model";
import {
  feishuDeliveryOperationsForHandle,
  feishuFollowTemplateSpec,
  feishuSourceOperations,
  FeishuDeliveryAdapter,
  FeishuUxcClient,
  expandFeishuFollowTemplate,
  invokeFeishuDeliveryOperation,
  invokeFeishuSourceOperation,
  type FeishuCallClient,
  normalizeFeishuBotEvent,
} from "../src/sources/feishu";

const FEISHU_IM_SCHEMA_URL =
  "https://raw.githubusercontent.com/holon-run/uxc/main/skills/feishu-openapi-skill/references/feishu-im.openapi.json";

class FakeFeishuUxcClient implements FeishuCallClient {
  public calls: Array<Record<string, unknown>> = [];

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    return { data: { ok: true } };
  }
}

class ContextFeishuUxcClient implements FeishuCallClient {
  public calls: Array<Record<string, unknown>> = [];

  async call(args: Record<string, unknown>) {
    this.calls.push(args);
    if (args.operation === "get:/im/v1/messages/{message_id}") {
      return {
        data: {
          code: 0,
          data: {
            items: [{
              message_id: "om_anchor",
              chat_id: "oc_chat",
              chat_type: "group",
              msg_type: "text",
              body: { content: "{\"text\":\"@TupTup Assistant hi\"}" },
              mentions: [{ key: "@_user_1", name: "TupTup Assistant", id: { open_id: "ou_bot" } }],
              sender: { id: { open_id: "ou_sender" }, sender_type: "user" },
              create_time: "1773491924409",
            }],
          },
        },
      };
    }
    if (args.operation === "get:/im/v1/messages") {
      throw new Error("Feishu API error 230027: missing im:message.group_msg");
    }
    return { data: { code: 0 } };
  }
}

test("normalizeFeishuBotEvent extracts metadata and delivery handle", () => {
  const source: SourceStream = {
    sourceId: "src_feishu",
    sourceType: "feishu_bot",
    sourceKey: "tenant-default",
    configRef: null,
    config: { uxcAuth: "feishu-default" },
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

test("normalizeFeishuBotEvent accepts flat lark-cli style events", () => {
  const source: SourceStream = {
    sourceId: "src_feishu",
    sourceType: "feishu_bot",
    sourceKey: "tenant-default",
    configRef: null,
    config: { uxcAuth: "feishu-default" },
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const normalized = normalizeFeishuBotEvent(source, { uxcAuth: "feishu-default" }, {
    type: "im.message.receive_v1",
    event_id: "fevt_flat",
    message_id: "om_flat",
    chat_id: "oc_chat",
    message_type: "text",
    content: "{\"text\":\"flat hello\"}",
    create_time: "1773491924409",
    sender_id: { open_id: "ou_sender" },
  });

  assert.ok(normalized);
  assert.equal(normalized.sourceNativeId, "feishu_event:fevt_flat");
  assert.equal(normalized.metadata?.messageId, "om_flat");
  assert.equal(normalized.metadata?.content, "flat hello");
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
    createdAt: new Date().toISOString(),
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

test("feishu delivery operations expose a canonical send_text action", () => {
  assert.deepEqual(
    feishuDeliveryOperationsForHandle({
      provider: "feishu",
      surface: "message_reply",
      targetRef: "om_reply",
    }).map((operation) => operation.name),
    ["send_text"],
  );
});

test("feishu delivery invoke maps send_text to the canonical outbound path", async () => {
  const fake = new FakeFeishuUxcClient();
  const client = new FeishuUxcClient(fake);
  await invokeFeishuDeliveryOperation({
    provider: "feishu",
    surface: "chat_message",
    targetRef: "oc_chat",
  }, "send_text", { text: "team update" }, client);
  assert.equal(fake.calls[0]?.operation, "post:/im/v1/messages");
});

test("feishu follow templates expand chat and mention subscriptions over a shared uxc source", () => {
  assert.deepEqual(feishuFollowTemplateSpec().map((template) => template.templateId), ["feishu.chat", "feishu.mention"]);

  const source: SourceStream = {
    sourceId: "preview",
    sourceType: "feishu_bot",
    sourceKey: "preview",
    configRef: null,
    config: { uxcAuth: "feishu-tuptup", chatId: "oc_chat", openId: "ou_bot" },
    status: "active",
    checkpoint: null,
    createdAt: "",
    updatedAt: "",
  };
  const plan = expandFeishuFollowTemplate({
    template: "mention",
    args: { chatId: "oc_chat", openId: "ou_bot" },
    source,
  });

  assert.ok(plan);
  assert.equal(plan.templateId, "feishu.mention");
  assert.equal(plan.sources[0]?.sourceKey, "feishu:feishu-tuptup:messages");
  assert.deepEqual(plan.sources[0]?.config, {
    uxcAuth: "feishu-tuptup",
    eventTypes: ["im.message.receive_v1"],
  });
  assert.deepEqual(plan.subscriptions[0]?.filter, {
    metadata: { chatId: "oc_chat" },
    expr: "contains(metadata.mentionOpenIds, \"ou_bot\")",
  });
});

test("feishu source operation fetches anchor message context and keeps permission warnings non-fatal", async () => {
  const fake = new ContextFeishuUxcClient();
  const client = new FeishuUxcClient(fake);
  const source: SourceStream = {
    sourceId: "src_feishu",
    sourceType: "feishu_bot",
    sourceKey: "tenant-default",
    configRef: null,
    config: { uxcAuth: "feishu-tuptup" },
    status: "active",
    checkpoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(feishuSourceOperations()[0]?.name, "get_message_context");
  const result = await invokeFeishuSourceOperation(source, "get_message_context", { messageId: "om_anchor" }, client);

  assert.equal(fake.calls[0]?.operation, "get:/im/v1/messages/{message_id}");
  assert.equal((fake.calls[0]?.options as Record<string, unknown>)?.auth, "feishu-tuptup");
  assert.equal(fake.calls[1]?.operation, "get:/im/v1/messages");
  assert.equal((result.anchorMessage as Record<string, unknown> | null)?.messageId, "om_anchor");
  assert.equal((result.anchorMessage as Record<string, unknown> | null)?.content, "@TupTup Assistant hi");
  assert.equal((result.anchorMessage as Record<string, unknown> | null)?.senderOpenId, "ou_sender");
  assert.deepEqual(result.chatWindowMessages, []);
  assert.equal((result.warnings as Array<Record<string, unknown>>)[0]?.code, "chat_window_unavailable");
  assert.deepEqual(result.deliveryHandle, {
    provider: "feishu",
    surface: "message_reply",
    targetRef: "om_anchor",
    threadRef: null,
    replyMode: "reply",
  });
});
