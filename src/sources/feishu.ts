import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  DeliveryRequest,
  SubscriptionSource,
} from "../model";

export const FEISHU_OPENAPI_ENDPOINT = "https://open.feishu.cn/open-apis";
export const FEISHU_IM_SCHEMA_URL =
  "https://raw.githubusercontent.com/holon-run/uxc/main/skills/feishu-openapi-skill/references/feishu-im.openapi.json";
export const DEFAULT_FEISHU_EVENT_TYPES = ["im.message.receive_v1"];

export interface FeishuBotSourceConfig {
  endpoint?: string;
  schemaUrl?: string;
  uxcAuth?: string;
  eventTypes?: string[];
  chatIds?: string[];
}

export interface FeishuCallClient {
  call(args: {
    endpoint: string;
    operation: string;
    payload?: Record<string, unknown>;
    options?: { auth?: string; schema_url?: string };
  }): Promise<{ data: unknown }>;
}

export class FeishuUxcClient {
  constructor(private readonly client: FeishuCallClient = new UxcDaemonClient({ env: process.env })) {}

  async sendChatMessage(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    chatId: string;
    msgType: string;
    content: string;
    uuid?: string;
  }): Promise<void> {
    await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "post:/im/v1/messages",
      payload: {
        receive_id_type: "chat_id",
        receive_id: input.chatId,
        msg_type: input.msgType,
        content: input.content,
        uuid: input.uuid ?? null,
      },
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
  }

  async replyToMessage(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    messageId: string;
    msgType: string;
    content: string;
    replyInThread?: boolean;
    uuid?: string;
  }): Promise<void> {
    await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "post:/im/v1/messages/{message_id}/reply",
      payload: {
        message_id: input.messageId,
        msg_type: input.msgType,
        content: input.content,
        reply_in_thread: input.replyInThread ?? null,
        uuid: input.uuid ?? null,
      },
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
  }
}

export class FeishuDeliveryAdapter {
  private readonly client: FeishuUxcClient;

  constructor(client?: FeishuUxcClient) {
    this.client = client ?? new FeishuUxcClient();
  }

  async send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: "sent"; note: string }> {
    return invokeFeishuDeliveryOperation(attempt, "send_text", request.payload, this.client);
  }
}

export function feishuDeliveryOperationsForHandle(handle: DeliveryHandle): DeliveryOperationDescriptor[] {
  if (handle.surface !== "message_reply" && handle.surface !== "chat_message") {
    return [];
  }
  return [{
    name: "send_text",
    title: handle.surface === "message_reply" ? "Reply With Text" : "Send Text Message",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1 },
      },
    },
    canonicalTextAlias: true,
  }];
}

export async function invokeFeishuDeliveryOperation(
  handle: DeliveryHandle,
  operation: string,
  input: Record<string, unknown>,
  client: FeishuUxcClient = new FeishuUxcClient(),
): Promise<{ status: "sent"; note: string }> {
  if (operation !== "send_text") {
    throw new Error(`unknown Feishu delivery operation: ${operation}`);
  }
  const config = parseDeliveryConfig(input);
  const message = normalizeDeliveryMessage(input);

  if (handle.surface === "message_reply") {
    await client.replyToMessage({
      endpoint: config.endpoint,
      schemaUrl: config.schemaUrl,
      auth: config.auth,
      messageId: handle.targetRef,
      msgType: message.msgType,
      content: message.content,
      replyInThread: config.replyInThread,
      uuid: config.uuid,
    });
    return { status: "sent", note: "sent Feishu message reply" };
  }

  if (handle.surface === "chat_message") {
    await client.sendChatMessage({
      endpoint: config.endpoint,
      schemaUrl: config.schemaUrl,
      auth: config.auth,
      chatId: handle.targetRef,
      msgType: message.msgType,
      content: message.content,
      uuid: config.uuid,
    });
    return { status: "sent", note: "sent Feishu chat message" };
  }

  throw new Error(`deliver send only supports canonical Feishu text surfaces; use deliver invoke for ${handle.surface}`);
}

export function normalizeFeishuBotEvent(
  source: SubscriptionSource,
  config: FeishuBotSourceConfig,
  raw: unknown,
): AppendSourceEventInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const payload = raw as Record<string, unknown>;
  const header = asRecord(payload.header);
  const eventType = asString(payload.event_type) ?? asString(header.event_type);
  if (!eventType || !(config.eventTypes ?? DEFAULT_FEISHU_EVENT_TYPES).includes(eventType)) {
    return null;
  }

  const event = asRecord(payload.event);
  const message = nonEmptyRecord(payload.message) ?? nonEmptyRecord(event.message) ?? {};
  const sender = nonEmptyRecord(payload.sender) ?? nonEmptyRecord(event.sender) ?? {};

  const messageId = asString(message.message_id);
  const eventId = asString(header.event_id) ?? messageId;
  const chatId = asString(message.chat_id);
  if (!eventId || !messageId || !chatId) {
    return null;
  }

  if (config.chatIds && config.chatIds.length > 0 && !config.chatIds.includes(chatId)) {
    return null;
  }

  const mentions = extractMentionNames(message.mentions);
  const mentionOpenIds = extractMentionOpenIds(message.mentions);
  const messageType = asString(message.message_type) ?? "unknown";
  const senderId = asString(asRecord(sender.sender_id).open_id);
  const senderType = asString(sender.sender_type);
  const content = stringifyFeishuMessageContent(messageType, asString(message.content), message.mentions);
  const threadId = asString(message.thread_id) ?? asString(message.root_id);
  const parentId = asString(message.parent_id);

  return {
    sourceId: source.sourceId,
    sourceNativeId: `feishu_event:${eventId}`,
    eventVariant: `${eventType}.${messageType}`,
    occurredAt: fromUnixMillisString(asString(message.create_time))
      ?? fromUnixMillisString(asString(header.create_time))
      ?? new Date().toISOString(),
    metadata: {
      provider: "feishu",
      eventType,
      chatId,
      chatType: asString(message.chat_type),
      messageId,
      messageType,
      senderOpenId: senderId,
      senderType,
      mentions,
      mentionOpenIds,
      content,
      threadId,
      parentId,
    },
    rawPayload: {
      header,
      event_type: eventType,
      event,
      message,
      sender,
    },
    deliveryHandle: {
      provider: "feishu",
      surface: "message_reply",
      targetRef: messageId,
      threadRef: threadId ?? parentId ?? null,
      replyMode: "reply",
    },
  };
}

export function parseFeishuSourceConfig(source: SubscriptionSource): FeishuBotSourceConfig {
  const config = source.config ?? {};
  return {
    endpoint: asString(config.endpoint) ?? FEISHU_OPENAPI_ENDPOINT,
    schemaUrl: asString(config.schemaUrl) ?? FEISHU_IM_SCHEMA_URL,
    uxcAuth: asString(config.uxcAuth) ?? source.configRef ?? asString(config.credentialRef) ?? undefined,
    eventTypes: asStringArray(config.eventTypes) ?? DEFAULT_FEISHU_EVENT_TYPES,
    chatIds: asStringArray(config.chatIds) ?? undefined,
  };
}

function parseDeliveryConfig(payload: Record<string, unknown>): {
  endpoint?: string;
  schemaUrl?: string;
  auth?: string;
  replyInThread?: boolean;
  uuid?: string;
} {
  return {
    endpoint: asString(payload.endpoint) ?? undefined,
    schemaUrl: asString(payload.schemaUrl) ?? asString(payload.schema_url) ?? FEISHU_IM_SCHEMA_URL,
    auth: asString(payload.uxcAuth) ?? asString(payload.auth) ?? undefined,
    replyInThread: typeof payload.replyInThread === "boolean"
      ? payload.replyInThread
      : typeof payload.reply_in_thread === "boolean"
        ? payload.reply_in_thread
        : undefined,
    uuid: asString(payload.uuid) ?? undefined,
  };
}

function normalizeDeliveryMessage(payload: Record<string, unknown>): { msgType: string; content: string } {
  const explicitContent = asString(payload.content);
  const explicitMsgType = asString(payload.msgType) ?? asString(payload.msg_type);
  if (explicitContent && explicitMsgType) {
    return { msgType: explicitMsgType, content: explicitContent };
  }
  if (typeof payload.text === "string") {
    return {
      msgType: "text",
      content: JSON.stringify({ text: payload.text }),
    };
  }
  return {
    msgType: "text",
    content: JSON.stringify({ text: JSON.stringify(payload) }),
  };
}

function extractMentionNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names = raw
    .map((item) => asRecord(item))
    .map((item) => asString(item.name))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(names)).sort();
}

function extractMentionOpenIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids = raw
    .map((item) => asRecord(item))
    .map((item) => {
      const id = item.id;
      if (typeof id === "string") {
        return id;
      }
      return asString(asRecord(id).open_id);
    })
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(ids)).sort();
}

function stringifyFeishuMessageContent(
  messageType: string,
  rawContent: string | null,
  mentions: unknown,
): string | null {
  if (!rawContent) {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  if (messageType === "text") {
    return asString(asRecord(parsed).text) ?? rawContent;
  }

  if (messageType === "post") {
    const mentionMap = buildMentionMap(mentions);
    const lines = flattenPostContent(parsed, mentionMap);
    return lines.length > 0 ? lines.join("\n") : rawContent;
  }

  if (messageType === "image") {
    return imagePlaceholder(parsed);
  }
  if (messageType === "file" || messageType === "audio" || messageType === "video" || messageType === "media") {
    return filePlaceholder(parsed, messageType);
  }
  if (messageType === "interactive") {
    return "[interactive card]";
  }

  const text = asString(asRecord(parsed).text);
  return text ?? JSON.stringify(parsed);
}

function buildMentionMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(raw)) {
    return map;
  }
  for (const item of raw) {
    const value = asRecord(item);
    const key = asString(value.key);
    const name = asString(value.name);
    if (key && name) {
      map.set(key, `@${name}`);
    }
  }
  return map;
}

function flattenPostContent(raw: unknown, mentionMap: Map<string, string>): string[] {
  const parsed = asRecord(raw);
  const localeEntries = Object.entries(parsed);
  const content = asRecord(localeEntries[0]?.[1]).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const lines: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) {
      continue;
    }
    const parts = row
      .map((cell) => {
        const record = asRecord(cell);
        const tag = asString(record.tag);
        if (tag === "text") {
          return asString(record.text) ?? "";
        }
        if (tag === "a") {
          return asString(record.text) ?? asString(record.href) ?? "";
        }
        if (tag === "at") {
          const key = asString(record.user_id);
          return (key && mentionMap.get(key)) ?? asString(record.user_name) ?? "@mention";
        }
        if (tag === "img") {
          return "[image]";
        }
        return "";
      })
      .filter((value) => value.length > 0);
    if (parts.length > 0) {
      lines.push(parts.join(""));
    }
  }
  return lines;
}

function imagePlaceholder(raw: unknown): string {
  const imageKey = asString(asRecord(raw).image_key);
  return imageKey ? `[image:${imageKey}]` : "[image]";
}

function filePlaceholder(raw: unknown, kind: string): string {
  const fileKey = asString(asRecord(raw).file_key);
  return fileKey ? `[${kind}:${fileKey}]` : `[${kind}]`;
}

function fromUnixMillisString(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const millis = Number(value);
  if (!Number.isFinite(millis)) {
    return null;
  }
  return new Date(millis).toISOString();
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));
}
