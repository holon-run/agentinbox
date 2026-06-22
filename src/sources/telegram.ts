import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryOperationDescriptor,
  DeliveryRequest,
  SourceStream,
} from "../model";

export const TELEGRAM_BOT_API_ENDPOINT = "https://api.telegram.org";

export interface TelegramBotSourceConfig {
  endpoint?: string;
  uxcAuth?: string;
  botToken?: string;
  tokenEnv?: string;
  botUsername?: string;
  chatIds?: string[];
  allowedUpdates?: string[];
}

export interface TelegramFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface TelegramFetchClient {
  fetch(url: string, init?: RequestInit): Promise<TelegramFetchResponse>;
}

export class TelegramBotApiClient {
  constructor(private readonly client: TelegramFetchClient = { fetch: (url, init) => fetch(url, init) }) {}

  async getUpdates(input: {
    endpoint?: string;
    botToken: string;
    offset?: number;
    timeout?: number;
    allowedUpdates?: string[];
  }): Promise<Record<string, unknown>[]> {
    const endpoint = stripTrailingSlash(input.endpoint ?? TELEGRAM_BOT_API_ENDPOINT);
    const params = new URLSearchParams();
    if (input.offset !== undefined) {
      params.set("offset", String(input.offset));
    }
    if (input.timeout !== undefined) {
      params.set("timeout", String(input.timeout));
    }
    if (input.allowedUpdates && input.allowedUpdates.length > 0) {
      params.set("allowed_updates", JSON.stringify(input.allowedUpdates));
    }
    const query = params.toString();
    const response = await this.client.fetch(`${endpoint}/bot${input.botToken}/getUpdates${query ? `?${query}` : ""}`);
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed with status ${response.status}: ${body}`);
    }
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Telegram getUpdates returned a non-object response");
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.ok !== true) {
      throw new Error(`Telegram getUpdates returned ok=false: ${body}`);
    }
    const result = envelope.result;
    if (!Array.isArray(result)) {
      throw new Error("Telegram getUpdates response missing result array");
    }
    return result
      .map((item) => asRecord(item))
      .filter((item) => Object.keys(item).length > 0);
  }

  async sendMessage(input: {
    endpoint?: string;
    botToken: string;
    chatId: string;
    text: string;
    replyToMessageId?: number;
    parseMode?: string;
  }): Promise<void> {
    const endpoint = stripTrailingSlash(input.endpoint ?? TELEGRAM_BOT_API_ENDPOINT);
    const body: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
    };
    if (input.replyToMessageId !== undefined) {
      body.reply_to_message_id = input.replyToMessageId;
    }
    if (input.parseMode) {
      body.parse_mode = input.parseMode;
    }
    const response = await this.client.fetch(`${endpoint}/bot${input.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with status ${response.status}: ${await response.text()}`);
    }
  }
}

export class TelegramDeliveryAdapter {
  private readonly client: TelegramBotApiClient;

  constructor(client?: TelegramBotApiClient) {
    this.client = client ?? new TelegramBotApiClient();
  }

  async send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: "sent"; note: string }> {
    return invokeTelegramDeliveryOperation(attempt, "send_text", request.payload, this.client);
  }
}

export function telegramDeliveryOperationsForHandle(handle: DeliveryHandle): DeliveryOperationDescriptor[] {
  if (handle.provider !== "telegram") {
    return [];
  }
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
        botToken: { type: "string", minLength: 1 },
        token: { type: "string", minLength: 1 },
        tokenEnv: { type: "string", minLength: 1 },
        chatId: { type: "string", minLength: 1 },
        chat_id: { type: "string", minLength: 1 },
        replyToMessageId: { type: "number" },
        reply_to_message_id: { type: "number" },
        parseMode: { type: "string", minLength: 1 },
        parse_mode: { type: "string", minLength: 1 },
      },
    },
    canonicalTextAlias: true,
  }];
}

export async function invokeTelegramDeliveryOperation(
  handle: DeliveryHandle,
  operation: string,
  input: Record<string, unknown>,
  client: TelegramBotApiClient = new TelegramBotApiClient(),
): Promise<{ status: "sent"; note: string }> {
  if (operation !== "send_text") {
    throw new Error(`unknown Telegram delivery operation: ${operation}`);
  }
  if (handle.provider !== "telegram") {
    throw new Error(`Telegram delivery operation requires a telegram handle, got ${handle.provider}`);
  }
  if (handle.surface !== "message_reply" && handle.surface !== "chat_message") {
    throw new Error(`deliver send only supports canonical Telegram text surfaces; use deliver invoke for ${handle.surface}`);
  }
  const text = asString(input.text);
  if (!text || text.trim().length === 0) {
    throw new Error("send_text requires input.text");
  }
  const botToken = asString(input.botToken)
    ?? asString(input.token)
    ?? tokenFromEnv(asString(input.tokenEnv));
  if (!botToken) {
    throw new Error("send_text requires input.botToken, input.token, or input.tokenEnv");
  }
  const chatId = stringFromUnknown(input.chatId) ?? stringFromUnknown(input.chat_id) ?? handle.targetRef;
  const replyToMessageId = numberFromUnknown(input.replyToMessageId)
    ?? numberFromUnknown(input.reply_to_message_id)
    ?? (handle.surface === "message_reply" ? numberFromUnknown(handle.threadRef) : undefined);

  await client.sendMessage({
    endpoint: asString(input.endpoint) ?? undefined,
    botToken,
    chatId,
    text,
    replyToMessageId,
    parseMode: asString(input.parseMode) ?? asString(input.parse_mode) ?? undefined,
  });

  return {
    status: "sent",
    note: handle.surface === "message_reply" ? "sent Telegram message reply" : "sent Telegram chat message",
  };
}

export function normalizeTelegramBotUpdate(
  source: SourceStream,
  config: TelegramBotSourceConfig,
  raw: unknown,
): AppendSourceEventInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const payload = raw as Record<string, unknown>;
  const updateId = stringFromUnknown(payload.update_id);
  if (!updateId) {
    return null;
  }
  const selected = selectTelegramMessage(payload);
  if (!selected) {
    return null;
  }
  const message = selected.message;
  const messageId = stringFromUnknown(message.message_id);
  const chat = asRecord(message.chat);
  const chatId = stringFromUnknown(chat.id);
  if (!messageId || !chatId) {
    return null;
  }
  if (config.chatIds && config.chatIds.length > 0 && !config.chatIds.includes(chatId)) {
    return null;
  }

  const from = asRecord(message.from);
  const content = asString(message.text) ?? asString(message.caption);
  const messageType = telegramMessageType(message);
  return {
    sourceId: source.sourceId,
    sourceNativeId: `telegram:${source.sourceId}:${updateId}`,
    eventVariant: `${selected.kind}.${messageType}`,
    occurredAt: fromUnixSeconds(message.date) ?? new Date().toISOString(),
    metadata: {
      provider: "telegram",
      updateId,
      chatId,
      chatType: asString(chat.type),
      messageId,
      messageType,
      fromId: stringFromUnknown(from.id),
      fromUsername: asString(from.username),
      fromFirstName: asString(from.first_name),
      content,
    },
    rawPayload: payload,
    deliveryHandle: {
      provider: "telegram",
      surface: "message_reply",
      targetRef: chatId,
      threadRef: messageId,
      replyMode: "reply",
    },
  };
}

export function parseTelegramSourceConfig(source: SourceStream): TelegramBotSourceConfig {
  const config = source.config ?? {};
  return {
    endpoint: asString(config.endpoint) ?? asString(config.apiBaseUrl) ?? TELEGRAM_BOT_API_ENDPOINT,
    uxcAuth: asString(config.uxcAuth) ?? asString(config.credentialRef) ?? undefined,
    botToken: asString(config.botToken) ?? undefined,
    tokenEnv: asString(config.tokenEnv) ?? undefined,
    botUsername: asString(config.botUsername) ?? undefined,
    chatIds: asStringArray(config.chatIds) ?? undefined,
    allowedUpdates: asStringArray(config.allowedUpdates) ?? undefined,
  };
}

function selectTelegramMessage(payload: Record<string, unknown>): { kind: string; message: Record<string, unknown> } | null {
  const candidates = [
    ["message", payload.message],
    ["edited_message", payload.edited_message],
    ["channel_post", payload.channel_post],
    ["edited_channel_post", payload.edited_channel_post],
  ] as const;
  for (const [kind, value] of candidates) {
    const message = asRecord(value);
    if (Object.keys(message).length > 0) {
      return { kind, message };
    }
  }
  return null;
}

function telegramMessageType(message: Record<string, unknown>): string {
  if (typeof message.text === "string") {
    return "text";
  }
  if (typeof message.caption === "string") {
    return "caption";
  }
  if (Array.isArray(message.photo)) {
    return "photo";
  }
  if (message.document && typeof message.document === "object") {
    return "document";
  }
  if (message.audio && typeof message.audio === "object") {
    return "audio";
  }
  if (message.video && typeof message.video === "object") {
    return "video";
  }
  if (message.voice && typeof message.voice === "object") {
    return "voice";
  }
  if (message.sticker && typeof message.sticker === "object") {
    return "sticker";
  }
  return "unknown";
}

function fromUnixSeconds(value: unknown): string | null {
  const seconds = numberFromUnknown(value);
  if (seconds === undefined) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function tokenFromEnv(name: string | null): string | null {
  if (!name) {
    return null;
  }
  return asString(process.env[name]);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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
  if (Array.isArray(value)) {
    return value
      .map((item) => stringFromUnknown(item))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
