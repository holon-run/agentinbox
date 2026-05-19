import { UxcDaemonClient } from "@holon-run/uxc-daemon-client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
const FEISHU_BOT_SCHEMA_FILE = join(tmpdir(), "agentinbox-feishu-bot.openapi.json");
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
    options?: { auth?: string; schema_url?: string; refresh_schema?: boolean; no_cache?: boolean };
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
      payload: compactPayload({
        receive_id_type: "chat_id",
        receive_id: input.chatId,
        msg_type: input.msgType,
        content: input.content,
        uuid: input.uuid,
      }),
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
      payload: compactPayload({
        message_id: input.messageId,
        msg_type: input.msgType,
        content: input.content,
        reply_in_thread: input.replyInThread,
        uuid: input.uuid,
      }),
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
  }

  async uploadFile(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    filePath: string;
    fileName: string;
    fileType?: string;
  }): Promise<string> {
    const response = await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "post:/im/v1/files",
      payload: {
        file_type: input.fileType ?? "stream",
        file_name: input.fileName,
        file: input.filePath,
      },
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
    const fileKey = findStringField(response.data, "file_key");
    if (!fileKey) {
      throw new Error("Feishu file upload response did not include file_key");
    }
    return fileKey;
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
    pageToken?: string;
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
    if (input.pageToken) {
      payload.page_token = input.pageToken;
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

  async getBotOpenId(input: {
    endpoint?: string;
    auth?: string;
  }): Promise<string> {
    const response = await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "get:/bot/v3/info",
      payload: {},
      options: {
        auth: input.auth,
        schema_url: ensureFeishuBotSchemaFile(),
        refresh_schema: true,
        no_cache: true,
      },
    });
    const openId = findStringField(response.data, "open_id");
    if (!openId) {
      throw new Error("Feishu bot info response did not include bot.open_id");
    }
    return openId;
  }

  async listChats(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<unknown> {
    const response = await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "get:/im/v1/chats",
      payload: compactPayload({
        page_size: input.pageSize ?? 20,
        page_token: input.pageToken,
      }),
      options: {
        auth: input.auth,
        schema_url: input.schemaUrl ?? FEISHU_IM_SCHEMA_URL,
      },
    });
    return response.data;
  }

  async getChat(input: {
    endpoint?: string;
    schemaUrl?: string;
    auth?: string;
    chatId: string;
  }): Promise<unknown> {
    const response = await this.client.call({
      endpoint: input.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      operation: "get:/im/v1/chats/{chat_id}",
      payload: {
        chat_id: input.chatId,
      },
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
  const commonProperties = commonDeliveryInputSchemaProperties();
  return [
    {
      name: "send_text",
      title: handle.surface === "message_reply" ? "Reply With Text" : "Send Text Message",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1 },
          ...commonProperties,
        },
      },
      canonicalTextAlias: true,
    },
    {
      name: "send_post",
      title: handle.surface === "message_reply" ? "Reply With Rich Text" : "Send Rich Text Message",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        anyOf: [
          { required: ["blocks"] },
          { required: ["paragraphs"] },
          { required: ["content"] },
        ],
        properties: {
          title: { type: "string" },
          locale: { type: "string", minLength: 1 },
          blocks: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          paragraphs: {
            type: "array",
            items: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
          content: {
            anyOf: [
              { type: "string", minLength: 1 },
              { type: "object", additionalProperties: true },
            ],
          },
          ...commonProperties,
        },
      },
    },
    {
      name: "send_file",
      title: handle.surface === "message_reply" ? "Reply With File" : "Send File Message",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        anyOf: [
          { required: ["fileKey"] },
          { required: ["file_key"] },
        ],
        properties: {
          fileKey: { type: "string", minLength: 1 },
          file_key: { type: "string", minLength: 1 },
          ...commonProperties,
        },
      },
    },
    {
      name: "send_file_from_path",
      title: handle.surface === "message_reply" ? "Upload And Reply With File" : "Upload And Send File",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        anyOf: [
          { required: ["filePath"] },
          { required: ["file_path"] },
        ],
        properties: {
          filePath: { type: "string", minLength: 1 },
          file_path: { type: "string", minLength: 1 },
          fileName: { type: "string", minLength: 1 },
          file_name: { type: "string", minLength: 1 },
          fileType: { type: "string", minLength: 1 },
          file_type: { type: "string", minLength: 1 },
          ...commonProperties,
        },
      },
    },
  ];
}

export async function invokeFeishuDeliveryOperation(
  handle: DeliveryHandle,
  operation: string,
  input: Record<string, unknown>,
  client: FeishuUxcClient = new FeishuUxcClient(),
): Promise<{ status: "sent"; note: string }> {
  const config = parseDeliveryConfig(input);
  if (operation === "send_text") {
    const text = asString(input.text);
    if (!text || text.trim().length === 0) {
      throw new Error("send_text requires input.text");
    }
    await sendFeishuMessage(handle, normalizeDeliveryMessage({ text }), config, client);
    return { status: "sent", note: sentNote(handle, "text") };
  }

  if (operation === "send_post") {
    const message = normalizeFeishuPostMessage(input);
    await sendFeishuMessage(handle, message, config, client);
    return { status: "sent", note: sentNote(handle, "rich text") };
  }

  if (operation === "send_file") {
    const fileKey = asString(input.fileKey) ?? asString(input.file_key);
    if (!fileKey) {
      throw new Error("send_file requires input.fileKey");
    }
    await sendFeishuMessage(handle, normalizeFeishuFileMessage(fileKey), config, client);
    return { status: "sent", note: sentNote(handle, "file") };
  }

  if (operation === "send_file_from_path") {
    const filePath = asString(input.filePath) ?? asString(input.file_path);
    if (!filePath) {
      throw new Error("send_file_from_path requires input.filePath");
    }
    const fileName = asString(input.fileName) ?? asString(input.file_name) ?? basename(filePath);
    const fileKey = await client.uploadFile({
      endpoint: config.endpoint,
      schemaUrl: config.schemaUrl,
      auth: config.auth,
      filePath,
      fileName,
      fileType: asString(input.fileType) ?? asString(input.file_type) ?? "stream",
    });
    await sendFeishuMessage(handle, normalizeFeishuFileMessage(fileKey), config, client);
    return { status: "sent", note: `${sentNote(handle, "file")} after upload` };
  }

  throw new Error(`unknown Feishu delivery operation: ${operation}`);
}

async function sendFeishuMessage(
  handle: DeliveryHandle,
  message: { msgType: string; content: string },
  config: ReturnType<typeof parseDeliveryConfig>,
  client: FeishuUxcClient,
): Promise<void> {
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
    return;
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
    return;
  }
  throw new Error(`deliver send only supports canonical Feishu text surfaces; use deliver invoke for ${handle.surface}`);
}

function sentNote(handle: DeliveryHandle, kind: string): string {
  return handle.surface === "message_reply"
    ? `sent Feishu ${kind} message reply`
    : `sent Feishu ${kind} chat message`;
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
    {
      templateId: "feishu.mentions",
      providerOrKind: "feishu",
      label: "Feishu Mentions",
      description: "Follow messages across visible Feishu/Lark chats that mention a user or bot.",
      argsSchema: [
        { name: "openId", type: "string", required: false, description: "Mentioned user or bot open_id. Defaults to the configured app bot open_id." },
      ],
    },
  ];
}

export async function expandFeishuFollowTemplate(
  input: ExpandFollowTemplateInput,
  client: FeishuUxcClient = new FeishuUxcClient(),
): Promise<ExpandedFollowPlan | null> {
  if (input.template !== "chat" && input.template !== "mention" && input.template !== "mentions") {
    return null;
  }
  const args = input.args ?? {};
  const chatId = asString(args.chatId);
  if (input.template !== "mentions" && !chatId) {
    throw new Error(`follow template feishu.${input.template} requires argument chatId`);
  }
  const config = parseFeishuSourceConfig(input.source);
  const sourceKey = `feishu:${config.uxcAuth ?? input.source.configRef ?? "default"}:messages`;
  const filter: SubscriptionFilter = chatId ? { metadata: { chatId } } : {};

  let trackedResourceRef = chatId ? `chat:${chatId}` : "mentions";
  if (input.template === "mention" || input.template === "mentions") {
    const openId = asString(args.openId) ?? await resolveFeishuMentionOpenId(input, config, client);
    if (!openId) {
      throw new Error(`follow template feishu.${input.template} requires argument openId`);
    }
    filter.expr = `contains(metadata.mentionOpenIds, ${JSON.stringify(openId)})`;
    trackedResourceRef = chatId ? `chat:${chatId}:mention:${openId}` : `mention:${openId}`;
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

async function resolveFeishuMentionOpenId(
  input: ExpandFollowTemplateInput,
  config: FeishuBotSourceConfig,
  client: FeishuUxcClient,
): Promise<string | null> {
  if (input.template !== "mentions") {
    return null;
  }
  return client.getBotOpenId({
    endpoint: config.endpoint,
    auth: config.uxcAuth ?? input.source.configRef ?? undefined,
  });
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
    {
      name: "list_recent_messages",
      title: "List Recent Messages",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["chatId"],
        properties: {
          chatId: { type: "string", minLength: 1 },
          limit: { type: "number", minimum: 1, maximum: 50 },
          before: { type: "string", minLength: 1 },
          pageToken: { type: "string", minLength: 1 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["chatId", "messages", "warnings"],
      },
    },
    {
      name: "list_chats",
      title: "List Chats",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", minimum: 1, maximum: 50 },
          pageToken: { type: "string", minLength: 1 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["chats", "warnings"],
      },
    },
    {
      name: "search_chats",
      title: "Search Chats",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "number", minimum: 1, maximum: 50 },
          pageToken: { type: "string", minLength: 1 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["chats", "warnings"],
      },
    },
    {
      name: "get_chat",
      title: "Get Chat",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["chatId"],
        properties: {
          chatId: { type: "string", minLength: 1 },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["chat", "warnings"],
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
  if (operation === "list_recent_messages") {
    return listRecentFeishuMessages(source, input, client);
  }
  if (operation === "list_chats") {
    return listFeishuChats(source, input, client);
  }
  if (operation === "search_chats") {
    return searchFeishuChats(source, input, client);
  }
  if (operation === "get_chat") {
    return getFeishuChat(source, input, client);
  }
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

async function listFeishuChats(
  source: SourceStream,
  input: Record<string, unknown>,
  client: FeishuUxcClient,
): Promise<Record<string, unknown>> {
  const config = parseFeishuSourceConfig(source);
  const raw = await withFeishuChatDiscoveryError("list_chats", () => client.listChats({
    endpoint: config.endpoint,
    schemaUrl: config.schemaUrl,
    auth: config.uxcAuth,
    pageSize: boundedPositiveInteger(input.limit, 20, 50),
    pageToken: asString(input.pageToken) ?? undefined,
  }));
  return feishuChatsResult(raw);
}

async function searchFeishuChats(
  source: SourceStream,
  input: Record<string, unknown>,
  client: FeishuUxcClient,
): Promise<Record<string, unknown>> {
  const query = asString(input.query)?.trim();
  if (!query) {
    throw new Error("search_chats requires input.query");
  }
  const config = parseFeishuSourceConfig(source);
  const limit = boundedPositiveInteger(input.limit, 20, 50);
  const raw = await withFeishuChatDiscoveryError("search_chats", () => client.listChats({
    endpoint: config.endpoint,
    schemaUrl: config.schemaUrl,
    auth: config.uxcAuth,
    pageSize: 50,
    pageToken: asString(input.pageToken) ?? undefined,
  }));
  return feishuChatsResult(raw, searchFeishuChatResults(normalizeFeishuChats(raw), query).slice(0, limit));
}

async function getFeishuChat(
  source: SourceStream,
  input: Record<string, unknown>,
  client: FeishuUxcClient,
): Promise<Record<string, unknown>> {
  const chatId = asString(input.chatId);
  if (!chatId) {
    throw new Error("get_chat requires input.chatId");
  }
  const config = parseFeishuSourceConfig(source);
  const raw = await withFeishuChatDiscoveryError("get_chat", () => client.getChat({
    endpoint: config.endpoint,
    schemaUrl: config.schemaUrl,
    auth: config.uxcAuth,
    chatId,
  }));
  return {
    chat: normalizeFeishuChat(raw),
    warnings: [],
  };
}

async function withFeishuChatDiscoveryError<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${operation} failed; ensure the configured Feishu UXC auth can read visible chats: ${message}`, { cause: error });
  }
}

function feishuChatsResult(raw: unknown, chats: NormalizedFeishuChat[] = normalizeFeishuChats(raw)): Record<string, unknown> {
  const pageToken = feishuResponsePageToken(raw);
  const hasMore = feishuResponseHasMore(raw);
  return {
    chats,
    warnings: [],
    ...(pageToken ? { pageToken } : {}),
    ...(hasMore != null ? { hasMore } : {}),
  };
}

function searchFeishuChatResults(chats: NormalizedFeishuChat[], query: string): NormalizedFeishuChat[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return chats.filter((chat) => {
    const fields = [chat.chatId, chat.name, chat.description, chat.type]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());
    return fields.some((value) => value.includes(needle));
  });
}

async function listRecentFeishuMessages(
  source: SourceStream,
  input: Record<string, unknown>,
  client: FeishuUxcClient,
): Promise<Record<string, unknown>> {
  const chatId = asString(input.chatId);
  if (!chatId) {
    throw new Error("list_recent_messages requires input.chatId");
  }
  const config = parseFeishuSourceConfig(source);
  const limit = boundedPositiveInteger(input.limit, 20, 50);
  const raw = await client.listMessages({
    endpoint: config.endpoint,
    schemaUrl: config.schemaUrl,
    auth: config.uxcAuth,
    chatId,
    endTime: asString(input.before) ?? undefined,
    pageToken: asString(input.pageToken) ?? undefined,
    pageSize: limit,
    sort: "ByCreateTimeDesc",
  });
  return {
    chatId,
    messages: normalizeFeishuMessages(raw),
    warnings: [],
    ...(feishuResponsePageToken(raw) ? { pageToken: feishuResponsePageToken(raw) } : {}),
    ...(feishuResponseHasMore(raw) != null ? { hasMore: feishuResponseHasMore(raw) } : {}),
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

function commonDeliveryInputSchemaProperties(): Record<string, unknown> {
  return {
    endpoint: { type: "string", minLength: 1 },
    schemaUrl: { type: "string", minLength: 1 },
    schema_url: { type: "string", minLength: 1 },
    uxcAuth: { type: "string", minLength: 1 },
    auth: { type: "string", minLength: 1 },
    replyInThread: { type: "boolean" },
    reply_in_thread: { type: "boolean" },
    uuid: { type: "string", minLength: 1 },
  };
}

function normalizeFeishuFileMessage(fileKey: string): { msgType: string; content: string } {
  return {
    msgType: "file",
    content: JSON.stringify({ file_key: fileKey }),
  };
}

function normalizeFeishuPostMessage(input: Record<string, unknown>): { msgType: string; content: string } {
  const rawContent = input.content;
  if (typeof rawContent === "string" && rawContent.trim().length > 0) {
    return { msgType: "post", content: rawContent };
  }
  if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    return { msgType: "post", content: JSON.stringify(rawContent) };
  }

  const paragraphs = normalizePostParagraphs(input);
  if (paragraphs.length === 0) {
    throw new Error("send_post requires input.blocks, input.paragraphs, or input.content");
  }
  const locale = asString(input.locale) ?? "zh_cn";
  return {
    msgType: "post",
    content: JSON.stringify({
      [locale]: {
        title: asString(input.title) ?? "",
        content: paragraphs,
      },
    }),
  };
}

function normalizePostParagraphs(input: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
  if (Array.isArray(input.paragraphs)) {
    return input.paragraphs
      .map((paragraph) => Array.isArray(paragraph) ? normalizePostBlocks(paragraph) : [])
      .filter((paragraph) => paragraph.length > 0);
  }
  if (Array.isArray(input.blocks)) {
    const paragraph = normalizePostBlocks(input.blocks);
    return paragraph.length > 0 ? [paragraph] : [];
  }
  return [];
}

function normalizePostBlocks(blocks: unknown[]): Array<Record<string, unknown>> {
  return blocks.map((block) => normalizePostBlock(asRecord(block))).filter((block): block is Record<string, unknown> => block !== null);
}

function normalizePostBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  const type = asString(block.type) ?? "text";
  if (type === "text") {
    const text = asString(block.text);
    if (!text) {
      return null;
    }
    return { tag: "text", text };
  }
  if (type === "link") {
    const text = asString(block.text);
    const url = asString(block.url) ?? asString(block.href);
    if (!text || !url) {
      return null;
    }
    return { tag: "a", text, href: url };
  }
  if (type === "mention") {
    const openId = asString(block.openId) ?? asString(block.open_id) ?? asString(block.userId) ?? asString(block.user_id);
    if (!openId) {
      return null;
    }
    return {
      tag: "at",
      user_id: openId,
      ...(asString(block.name) ? { user_name: asString(block.name) } : {}),
    };
  }
  return null;
}

function basename(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || "upload.bin";
}

function findStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = asString(record[field]);
  if (direct) {
    return direct;
  }
  for (const child of Object.values(record)) {
    const found = findStringField(child, field);
    if (found) {
      return found;
    }
  }
  return null;
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

interface NormalizedFeishuChat {
  chatId: string;
  name: string | null;
  description: string | null;
  type: string | null;
  memberCount: number | null;
  isBotMember: boolean | null;
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

function normalizeFeishuChat(raw: unknown): NormalizedFeishuChat | null {
  const chat = firstFeishuChat(raw);
  if (!chat) {
    return null;
  }
  return {
    chatId: asString(chat.chat_id) ?? "",
    name: asString(chat.name) ?? asString(chat.chat_name),
    description: asString(chat.description),
    type: asString(chat.chat_type) ?? asString(chat.chat_mode) ?? asString(chat.type),
    memberCount: asNumber(chat.member_count) ?? asNumber(chat.members_count) ?? asNumber(chat.user_count),
    isBotMember: asBoolean(chat.is_bot_member) ?? asBoolean(chat.bot_member) ?? asBoolean(chat.is_member),
    raw: chat,
  };
}

function normalizeFeishuChats(raw: unknown): NormalizedFeishuChat[] {
  return feishuChatItems(raw)
    .map((item) => normalizeFeishuChat(item))
    .filter((item): item is NormalizedFeishuChat => item !== null);
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

function firstFeishuChat(raw: unknown): Record<string, unknown> | null {
  const items = feishuChatItems(raw);
  if (items[0]) {
    return items[0];
  }
  const record = asRecord(raw);
  const data = asRecord(record.data);
  const nestedData = asRecord(data.data);
  if (asString(nestedData.chat_id)) {
    return nestedData;
  }
  if (asString(data.chat_id)) {
    return data;
  }
  if (asString(record.chat_id)) {
    return record;
  }
  return null;
}

function feishuChatItems(raw: unknown): Record<string, unknown>[] {
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
  return items.map((item) => asRecord(item)).filter((item) => asString(item.chat_id));
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

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(value, max);
}

function feishuResponsePageToken(raw: unknown): string | null {
  const record = asRecord(raw);
  const data = asRecord(record.data);
  const nestedData = asRecord(data.data);
  return asString(nestedData.page_token)
    ?? asString(data.page_token)
    ?? asString(record.page_token);
}

function feishuResponseHasMore(raw: unknown): boolean | null {
  const record = asRecord(raw);
  const data = asRecord(record.data);
  const nestedData = asRecord(data.data);
  if (typeof nestedData.has_more === "boolean") {
    return nestedData.has_more;
  }
  if (typeof data.has_more === "boolean") {
    return data.has_more;
  }
  return typeof record.has_more === "boolean" ? record.has_more : null;
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

function compactPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));
}

function ensureFeishuBotSchemaFile(): string {
  const body = JSON.stringify(FEISHU_BOT_OPENAPI_SCHEMA);
  writeFileSync(FEISHU_BOT_SCHEMA_FILE, body, "utf8");
  return FEISHU_BOT_SCHEMA_FILE;
}

const FEISHU_BOT_OPENAPI_SCHEMA = {
  openapi: "3.0.3",
  info: {
    title: "Feishu Bot Info",
    version: "1.0.0",
  },
  servers: [
    {
      url: FEISHU_OPENAPI_ENDPOINT,
    },
  ],
  // Feishu's docs site does not currently expose this as a stable
  // machine-readable OpenAPI document to UXC, so keep the tiny operation
  // schema needed for bot self-identification close to the adapter.
  paths: {
    "/bot/v3/info": {
      get: {
        operationId: "get:/bot/v3/info",
        summary: "Get bot information for the current app",
        responses: {
          "200": {
            description: "OK",
          },
        },
        security: [
          {
            bearerAuth: [],
          },
        ],
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "tenant_access_token",
      },
    },
  },
} as const;
