import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  DeliveryRequest,
  FollowTemplateSpec,
  SourceOperationDescriptor,
  SourceStream,
  SubscriptionFilter,
} from "../model";
import type { ExpandFollowTemplateInput, ExpandedFollowPlan } from "./remote_modules";

export const FEISHU_OPENAPI_ENDPOINT = "https://open.feishu.cn/open-apis";
export const FEISHU_IM_SCHEMA_URL =
  "https://raw.githubusercontent.com/holon-run/uxc/main/skills/feishu-openapi-skill/references/feishu-im.openapi.json";
export const DEFAULT_FEISHU_EVENT_TYPES = ["im.message.receive_v1"];
const DEFAULT_CONTEXT_BOUND_SECONDS = 7 * 24 * 60 * 60;

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

  async getMessage(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    messageId: string;
  }): Promise<unknown> {
    const response = await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "get:/im/v1/messages/{message_id}",
      payload: {
        message_id: input.messageId,
      },
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
    return response.data;
  }

  async listMessages(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    chatId: string;
    startTime?: string;
    endTime?: string;
    pageSize?: number;
    sort?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
  }): Promise<unknown> {
    const payload: Record<string, unknown> = {
      container_id_type: "chat",
      container_id: input.chatId,
      page_size: input.pageSize ?? 20,
      sort_type: input.sort ?? "ByCreateTimeAsc",
      card_msg_content_type: "raw_card_content",
    };
    if (input.startTime) {
      payload.start_time = input.startTime;
    }
    if (input.endTime) {
      payload.end_time = input.endTime;
    }
    const response = await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "get:/im/v1/messages",
      payload,
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
    return response.data;
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
        endpoint: { type: "string", minLength: 1 },
        schemaUrl: { type: "string", minLength: 1 },
        schema_url: { type: "string", minLength: 1 },
        uxcAuth: { type: "string", minLength: 1 },
        auth: { type: "string", minLength: 1 },
        replyInThread: { type: "boolean" },
        reply_in_thread: { type: "boolean" },
        uuid: { type: "string", minLength: 1 },
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
  const text = asString(input.text);
  if (!text || text.trim().length === 0) {
    throw new Error("send_text requires input.text");
  }
  const config = parseDeliveryConfig(input);
  const message = normalizeDeliveryMessage({ text });

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

export function feishuFollowTemplateSpec(): FollowTemplateSpec[] {
  return [
    {
      templateId: "feishu.chat",
      providerOrKind: "feishu",
      label: "Feishu Chat",
      description: "Follow messages from one Feishu/Lark chat.",
      argsSchema: [
        { name: "chatId", type: "string", required: true, description: "Feishu chat ID." },
      ],
    },
    {
      templateId: "feishu.mention",
      providerOrKind: "feishu",
      label: "Feishu Mention",
      description: "Follow messages in one Feishu/Lark chat that mention a user or bot.",
      argsSchema: [
        { name: "chatId", type: "string", required: true, description: "Feishu chat ID." },
        { name: "openId", type: "string", required: true, description: "Mentioned user or bot open_id." },
      ],
    },
  ];
}

export function expandFeishuFollowTemplate(input: ExpandFollowTemplateInput): ExpandedFollowPlan | null {
  if (input.template !== "chat" && input.template !== "mention") {
    return null;
  }
  const args = input.args ?? {};
  const chatId = asString(args.chatId);
  if (!chatId) {
    throw new Error(`follow template feishu.${input.template} requires argument chatId`);
  }
  const config = parseFeishuSourceConfig(input.source);
  const sourceKey = `feishu:${config.uxcAuth ?? input.source.configRef ?? "default"}:messages`;
  const filter: SubscriptionFilter = {
    metadata: { chatId },
  };

  let trackedResourceRef = `chat:${chatId}`;
  if (input.template === "mention") {
    const openId = asString(args.openId);
    if (!openId) {
      throw new Error("follow template feishu.mention requires argument openId");
    }
    filter.expr = `contains(metadata.mentionOpenIds, ${JSON.stringify(openId)})`;
    trackedResourceRef = `chat:${chatId}:mention:${openId}`;
  }

  return {
    templateId: `feishu.${input.template}`,
    sources: [
      {
        logicalName: "messages",
        sourceType: "feishu_bot",
        sourceKey,
        configRef: input.source.configRef ?? null,
        config: feishuFollowSourceConfig(input.source),
      },
    ],
    subscriptions: [
      {
        sourceLogicalName: "messages",
        filter,
        trackedResourceRef,
        cleanupPolicy: { mode: "manual" },
      },
    ],
  };
}

export function feishuSourceOperations(): SourceOperationDescriptor[] {
  return [
    {
      name: "get_message_context",
      title: "Get Message Context",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["messageId"],
        properties: {
          messageId: { type: "string", minLength: 1 },
          chatId: { type: "string", minLength: 1 },
          windowBefore: { type: "number", minimum: 0 },
          windowAfter: { type: "number", minimum: 0 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["anchorMessage", "chatWindowMessages", "threadMessages", "warnings", "deliveryHandle"],
      },
    },
  ];
}

export async function invokeFeishuSourceOperation(
  source: SourceStream,
  operation: string,
  input: Record<string, unknown>,
  client: FeishuUxcClient = new FeishuUxcClient(),
): Promise<Record<string, unknown>> {
  if (operation !== "get_message_context") {
    throw new Error(`unknown Feishu source operation: ${operation}`);
  }
  const messageId = asString(input.messageId);
  if (!messageId) {
    throw new Error("get_message_context requires input.messageId");
  }
  const config = parseFeishuSourceConfig(source);
  const anchorRaw = await client.getMessage({
    endpoint: config.endpoint,
    schemaUrl: config.schemaUrl,
    auth: config.uxcAuth,
    messageId,
  });
  const anchorMessage = normalizeFeishuMessage(anchorRaw);
  const chatId = asString(input.chatId) ?? anchorMessage?.chatId ?? null;
  const warnings: Array<{ code: string; message: string }> = [];
  let chatWindowMessages: NormalizedFeishuMessage[] = [];

  if (chatId) {
    const windowBefore = positiveInteger(input.windowBefore) ?? 5;
    const windowAfter = positiveInteger(input.windowAfter) ?? 5;
    try {
      chatWindowMessages = await fetchFeishuChatWindow({
        client,
        config,
        chatId,
        anchorMessage,
        windowBefore,
        windowAfter,
      });
    } catch (error) {
      warnings.push({
        code: "chat_window_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    anchorMessage,
    chatWindowMessages,
    threadMessages: [],
    warnings,
    deliveryHandle: {
      provider: "feishu",
      surface: "message_reply",
      targetRef: messageId,
      threadRef: anchorMessage?.threadId ?? anchorMessage?.parentId ?? null,
      replyMode: "reply",
    },
  };
}

export function normalizeFeishuBotEvent(
  source: SourceStream,
  config: FeishuBotSourceConfig,
  raw: unknown,
): AppendSourceEventInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const payload = raw as Record<string, unknown>;
  const header = asRecord(payload.header);
  const eventType = asString(payload.event_type) ?? asString(payload.type) ?? asString(header.event_type);
  if (!eventType || !(config.eventTypes ?? DEFAULT_FEISHU_EVENT_TYPES).includes(eventType)) {
    return null;
  }

  const event = asRecord(payload.event);
  const message = nonEmptyRecord(payload.message) ?? nonEmptyRecord(event.message) ?? flatFeishuMessage(payload);
  const sender = nonEmptyRecord(payload.sender) ?? nonEmptyRecord(event.sender) ?? flatFeishuSender(payload);

  const messageId = asString(message.message_id);
  const eventId = asString(payload.event_id) ?? asString(header.event_id) ?? messageId;
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
  const senderId = asString(asRecord(sender.sender_id).open_id) ?? asString(sender.sender_id);
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

function flatFeishuMessage(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    message_id: payload.message_id,
    chat_id: payload.chat_id,
    chat_type: payload.chat_type,
    message_type: payload.message_type ?? payload.msg_type,
    content: payload.content,
    create_time: payload.create_time,
    mentions: payload.mentions,
    thread_id: payload.thread_id,
    root_id: payload.root_id,
    parent_id: payload.parent_id,
  };
}

function flatFeishuSender(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    sender_id: payload.sender_id,
    sender_type: payload.sender_type,
  };
}

export function parseFeishuSourceConfig(source: SourceStream): FeishuBotSourceConfig {
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

interface NormalizedFeishuMessage {
  messageId: string;
  chatId: string | null;
  chatType: string | null;
  messageType: string;
  senderOpenId: string | null;
  senderType: string | null;
  mentions: string[];
  mentionOpenIds: string[];
  content: string | null;
  createdAt: string | null;
  threadId: string | null;
  parentId: string | null;
  raw: Record<string, unknown>;
}

function feishuFollowSourceConfig(source: SourceStream): Record<string, unknown> {
  const config = parseFeishuSourceConfig(source);
  return {
    ...(config.endpoint && config.endpoint !== FEISHU_OPENAPI_ENDPOINT ? { endpoint: config.endpoint } : {}),
    ...(config.schemaUrl && config.schemaUrl !== FEISHU_IM_SCHEMA_URL ? { schemaUrl: config.schemaUrl } : {}),
    ...(config.uxcAuth ? { uxcAuth: config.uxcAuth } : {}),
    ...(config.eventTypes ? { eventTypes: config.eventTypes } : {}),
  };
}

function normalizeFeishuMessage(raw: unknown): NormalizedFeishuMessage | null {
  const message = firstFeishuMessage(raw);
  if (!message) {
    return null;
  }
  const sender = asRecord(message.sender);
  const messageType = asString(message.msg_type) ?? asString(message.message_type) ?? "unknown";
  return {
    messageId: asString(message.message_id) ?? "",
    chatId: asString(message.chat_id),
    chatType: asString(message.chat_type),
    messageType,
    senderOpenId: senderOpenId(sender),
    senderType: asString(sender.sender_type) ?? asString(asRecord(sender.id).user_id) ?? null,
    mentions: extractMentionNames(message.mentions),
    mentionOpenIds: extractMentionOpenIds(message.mentions),
    content: stringifyFeishuMessageContent(messageType, messageContentString(message), message.mentions),
    createdAt: fromUnixMillisString(asString(message.create_time)),
    threadId: asString(message.thread_id) ?? asString(message.root_id),
    parentId: asString(message.parent_id),
    raw: message,
  };
}

function senderOpenId(sender: Record<string, unknown>): string | null {
  const nested = asString(asRecord(sender.id).open_id) ?? asString(asRecord(sender.sender_id).open_id);
  if (nested) {
    return nested;
  }
  const id = asString(sender.id) ?? asString(sender.sender_id);
  const idType = asString(sender.id_type);
  return id && (!idType || idType === "open_id") ? id : null;
}

function normalizeFeishuMessages(raw: unknown): NormalizedFeishuMessage[] {
  const items = feishuMessageItems(raw);
  return items
    .map((item) => normalizeFeishuMessage(item))
    .filter((item): item is NormalizedFeishuMessage => item !== null);
}

async function fetchFeishuChatWindow(input: {
  client: FeishuUxcClient;
  config: FeishuBotSourceConfig;
  chatId: string;
  anchorMessage: NormalizedFeishuMessage | null;
  windowBefore: number;
  windowAfter: number;
}): Promise<NormalizedFeishuMessage[]> {
  const anchorSeconds = feishuMessageCreateSeconds(input.anchorMessage);
  const pageSize = Math.max(1, Math.min(input.windowBefore + input.windowAfter + 1, 50));
  if (!anchorSeconds) {
    const fallbackRaw = await input.client.listMessages({
      endpoint: input.config.endpoint,
      schemaUrl: input.config.schemaUrl,
      auth: input.config.uxcAuth,
      chatId: input.chatId,
      pageSize,
    });
    return normalizeFeishuMessages(fallbackRaw);
  }

  const beforeRaw = input.windowBefore > 0
    ? await input.client.listMessages({
      endpoint: input.config.endpoint,
      schemaUrl: input.config.schemaUrl,
      auth: input.config.uxcAuth,
      chatId: input.chatId,
      startTime: String(Math.max(0, anchorSeconds - DEFAULT_CONTEXT_BOUND_SECONDS)),
      endTime: String(anchorSeconds + 1),
      pageSize: Math.max(1, Math.min(input.windowBefore + 1, 50)),
      sort: "ByCreateTimeDesc",
    })
    : null;
  const afterRaw = input.windowAfter > 0
    ? await input.client.listMessages({
      endpoint: input.config.endpoint,
      schemaUrl: input.config.schemaUrl,
      auth: input.config.uxcAuth,
      chatId: input.chatId,
      startTime: String(anchorSeconds),
      endTime: String(anchorSeconds + DEFAULT_CONTEXT_BOUND_SECONDS),
      pageSize: Math.max(1, Math.min(input.windowAfter + 1, 50)),
      sort: "ByCreateTimeAsc",
    })
    : null;

  return mergeFeishuMessages([
    ...(beforeRaw ? normalizeFeishuMessages(beforeRaw) : []),
    ...(input.anchorMessage ? [input.anchorMessage] : []),
    ...(afterRaw ? normalizeFeishuMessages(afterRaw) : []),
  ]);
}

function mergeFeishuMessages(messages: NormalizedFeishuMessage[]): NormalizedFeishuMessage[] {
  const byId = new Map<string, NormalizedFeishuMessage>();
  for (const message of messages) {
    if (message.messageId) {
      byId.set(message.messageId, message);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = feishuMessageCreateMillis(left) ?? 0;
    const rightTime = feishuMessageCreateMillis(right) ?? 0;
    return leftTime - rightTime;
  });
}

function feishuMessageCreateSeconds(message: NormalizedFeishuMessage | null): number | null {
  const millis = feishuMessageCreateMillis(message);
  return millis == null ? null : Math.floor(millis / 1000);
}

function feishuMessageCreateMillis(message: NormalizedFeishuMessage | null): number | null {
  if (!message) {
    return null;
  }
  const rawMillis = Number(asString(message.raw.create_time));
  if (Number.isFinite(rawMillis)) {
    return rawMillis;
  }
  if (message.createdAt) {
    const parsed = Date.parse(message.createdAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstFeishuMessage(raw: unknown): Record<string, unknown> | null {
  const items = feishuMessageItems(raw);
  if (items[0]) {
    return items[0];
  }
  const record = asRecord(raw);
  if (asString(record.message_id)) {
    return record;
  }
  return null;
}

function feishuMessageItems(raw: unknown): Record<string, unknown>[] {
  const record = asRecord(raw);
  const data = asRecord(record.data);
  const nestedData = asRecord(data.data);
  const items = Array.isArray(nestedData.items)
    ? nestedData.items
    : Array.isArray(data.items)
      ? data.items
      : Array.isArray(record.items)
        ? record.items
        : Array.isArray(raw)
          ? raw
          : [];
  return items.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0);
}

function messageContentString(message: Record<string, unknown>): string | null {
  const body = asRecord(message.body);
  return asString(body.content) ?? asString(message.content);
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
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
    const text = asString(asRecord(parsed).text) ?? rawContent;
    return replaceMentionKeys(text, mentions);
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

function replaceMentionKeys(text: string, mentions: unknown): string {
  let result = text;
  for (const [key, name] of buildMentionMap(mentions)) {
    result = result.split(key).join(name);
  }
  return result;
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
