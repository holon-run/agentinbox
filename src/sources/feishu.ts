import { UxcDaemonClient, type SubscribeStartResponse, type SubscriptionEventEnvelope } from "@holon-run/uxc-daemon-client";
import {
  AppendSourceEventInput,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryRequest,
  SourcePollResult,
  SubscriptionSource,
} from "../model";
import { AgentInboxStore } from "../store";

const FEISHU_OPENAPI_ENDPOINT = "https://open.feishu.cn/open-apis";
const FEISHU_IM_SCHEMA_URL =
  "https://raw.githubusercontent.com/holon-run/uxc/main/skills/feishu-openapi-skill/references/feishu-im.openapi.json";
const DEFAULT_EVENT_TYPES = ["im.message.receive_v1"];
const DEFAULT_SYNC_INTERVAL_SECS = 2;
const MAX_ERROR_BACKOFF_MULTIPLIER = 8;

export interface FeishuBotSourceConfig {
  endpoint?: string;
  schemaUrl?: string;
  uxcAuth?: string;
  eventTypes?: string[];
  chatIds?: string[];
}

interface FeishuSourceCheckpoint {
  uxcJobId?: string;
  afterSeq?: number;
  lastEventAt?: string;
  lastError?: string | null;
}

export interface FeishuUxcLikeClient {
  subscribeStart(args: {
    endpoint: string;
    mode?: "stream" | "poll";
    options?: { auth?: string };
    sink?: "memory:" | `file:${string}`;
    ephemeral?: boolean;
    transportHint?: "feishu_long_connection";
  }): Promise<SubscribeStartResponse>;
  subscribeStatus(jobId: string): Promise<{ status: string }>;
  subscriptionEvents(args: {
    jobId: string;
    afterSeq?: number;
    limit?: number;
    waitMs?: number;
  }): Promise<{ status: string; events: SubscriptionEventEnvelope[]; next_after_seq: number; has_more: boolean }>;
  call(args: {
    endpoint: string;
    operation: string;
    payload?: Record<string, unknown>;
    options?: { auth?: string; schema_url?: string };
  }): Promise<{ data: unknown }>;
}

export class FeishuUxcClient {
  constructor(private readonly client: FeishuUxcLikeClient = new UxcDaemonClient({ env: process.env })) {}

  async ensureLongConnectionSubscription(
    config: FeishuBotSourceConfig,
    checkpoint: FeishuSourceCheckpoint,
  ): Promise<SubscribeStartResponse> {
    if (checkpoint.uxcJobId) {
      try {
        const status = await this.client.subscribeStatus(checkpoint.uxcJobId);
        if (status.status === "running" || status.status === "reconnecting") {
          return {
            job_id: checkpoint.uxcJobId,
            mode: "stream",
            protocol: "feishu_long_connection",
            endpoint: config.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
            sink: "memory:",
            status: status.status,
          };
        }
      } catch {
        // Recreate the job below.
      }
    }

    return this.client.subscribeStart({
      endpoint: config.endpoint ?? FEISHU_OPENAPI_ENDPOINT,
      mode: "stream",
      options: { auth: config.uxcAuth },
      sink: "memory:",
      ephemeral: false,
      transportHint: "feishu_long_connection",
    });
  }

  async readSubscriptionEvents(jobId: string, afterSeq: number): Promise<{ events: SubscriptionEventEnvelope[]; nextAfterSeq: number; status: string }> {
    const response = await this.client.subscriptionEvents({
      jobId,
      afterSeq,
      limit: 100,
      waitMs: 10,
    });
    return {
      events: response.events,
      nextAfterSeq: response.next_after_seq,
      status: response.status,
    };
  }

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

export class FeishuSourceRuntime {
  private readonly client: FeishuUxcClient;
  private interval: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private readonly errorCounts = new Map<string, number>();
  private readonly nextRetryAt = new Map<string, number>();

  constructor(
    private readonly store: AgentInboxStore,
    private readonly appendSourceEvent: (input: AppendSourceEventInput) => Promise<{ appended: number; deduped: number }>,
    client?: FeishuUxcClient,
  ) {
    this.client = client ?? new FeishuUxcClient();
  }

  async ensureSource(source: SubscriptionSource): Promise<void> {
    if (source.sourceType !== "feishu_bot") {
      return;
    }
    const config = parseFeishuSourceConfig(source);
    const checkpoint = parseFeishuCheckpoint(source.checkpoint);
    const started = await this.client.ensureLongConnectionSubscription(config, checkpoint);
    this.store.updateSourceRuntime(source.sourceId, {
      status: "active",
      checkpoint: JSON.stringify({
        ...checkpoint,
        uxcJobId: started.job_id,
      }),
    });
  }

  async start(): Promise<void> {
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      void this.syncAll();
    }, 2_000);
    try {
      await this.syncAll();
    } catch (error) {
      console.warn("feishu_bot initial sync failed:", error);
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return this.syncSource(sourceId);
  }

  status(): Record<string, unknown> {
    return {
      activeSourceIds: Array.from(this.inFlight.values()).sort(),
      erroredSourceIds: Array.from(this.errorCounts.keys()).sort(),
    };
  }

  private async syncAll(): Promise<void> {
    const sources = this.store
      .listSources()
      .filter((source) => source.sourceType === "feishu_bot" && source.status !== "paused");
    for (const source of sources) {
      try {
        await this.syncSource(source.sourceId);
      } catch (error) {
        console.warn(`feishu_bot sync failed for ${source.sourceId}:`, error);
      }
    }
  }

  private async syncSource(sourceId: string): Promise<SourcePollResult> {
    if (this.inFlight.has(sourceId)) {
      return {
        sourceId,
        sourceType: "feishu_bot",
        appended: 0,
        deduped: 0,
        eventsRead: 0,
        note: "source sync already in flight",
      };
    }
    this.inFlight.add(sourceId);
    try {
      const source = this.store.getSource(sourceId);
      if (!source) {
        throw new Error(`unknown source: ${sourceId}`);
      }
      const config = parseFeishuSourceConfig(source);
      if (source.status === "error") {
        const retryAt = this.nextRetryAt.get(sourceId) ?? 0;
        if (Date.now() < retryAt) {
          return {
            sourceId,
            sourceType: "feishu_bot",
            appended: 0,
            deduped: 0,
            eventsRead: 0,
            note: "error backoff not elapsed",
          };
        }
      }
      let checkpoint = parseFeishuCheckpoint(source.checkpoint);
      const subscription = await this.client.ensureLongConnectionSubscription(config, checkpoint);
      if (subscription.job_id !== checkpoint.uxcJobId) {
        checkpoint = { ...checkpoint, uxcJobId: subscription.job_id };
      }

      const batch = await this.client.readSubscriptionEvents(checkpoint.uxcJobId!, checkpoint.afterSeq ?? 0);
      let appended = 0;
      let deduped = 0;
      for (const event of batch.events) {
        if (event.event_kind !== "data") {
          continue;
        }
        const normalized = normalizeFeishuBotEvent(source, config, event.data);
        if (!normalized) {
          continue;
        }
        const result = await this.appendSourceEvent(normalized);
        appended += result.appended;
        deduped += result.deduped;
      }

      this.store.updateSourceRuntime(sourceId, {
        status: "active",
        checkpoint: JSON.stringify({
          ...checkpoint,
          uxcJobId: checkpoint.uxcJobId,
          afterSeq: batch.nextAfterSeq,
          lastEventAt: new Date().toISOString(),
          lastError: null,
        }),
      });
      this.errorCounts.delete(sourceId);
      this.nextRetryAt.delete(sourceId);

      return {
        sourceId,
        sourceType: "feishu_bot",
        appended,
        deduped,
        eventsRead: batch.events.length,
        note: `subscription status=${batch.status}`,
      };
    } catch (error) {
      const source = this.store.getSource(sourceId);
      if (source) {
        const checkpoint = parseFeishuCheckpoint(source.checkpoint);
        const nextErrorCount = (this.errorCounts.get(sourceId) ?? 0) + 1;
        this.errorCounts.set(sourceId, nextErrorCount);
        this.nextRetryAt.set(
          sourceId,
          Date.now() + computeErrorBackoffMs(DEFAULT_SYNC_INTERVAL_SECS, nextErrorCount),
        );
        this.store.updateSourceRuntime(sourceId, {
          status: "error",
          checkpoint: JSON.stringify({
            ...checkpoint,
            lastError: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      throw error;
    } finally {
      this.inFlight.delete(sourceId);
    }
  }
}

function computeErrorBackoffMs(syncIntervalSecs: number, errorCount: number): number {
  const baseMs = Math.max(1, syncIntervalSecs) * 1000;
  const multiplier = Math.min(2 ** Math.max(0, errorCount - 1), MAX_ERROR_BACKOFF_MULTIPLIER);
  return baseMs * multiplier;
}

export class FeishuDeliveryAdapter {
  private readonly client: FeishuUxcClient;

  constructor(client?: FeishuUxcClient) {
    this.client = client ?? new FeishuUxcClient();
  }

  async send(request: DeliveryRequest, attempt: DeliveryAttempt): Promise<{ status: "sent"; note: string }> {
    const config = parseDeliveryConfig(request.payload);
    const message = normalizeDeliveryMessage(request.payload);

    if (attempt.surface === "message_reply") {
      await this.client.replyToMessage({
        endpoint: config.endpoint,
        schemaUrl: config.schemaUrl,
        auth: config.auth,
        messageId: attempt.targetRef,
        msgType: message.msgType,
        content: message.content,
        replyInThread: config.replyInThread,
        uuid: config.uuid,
      });
      return { status: "sent", note: "sent Feishu message reply" };
    }

    if (attempt.surface === "chat_message") {
      await this.client.sendChatMessage({
        endpoint: config.endpoint,
        schemaUrl: config.schemaUrl,
        auth: config.auth,
        chatId: attempt.targetRef,
        msgType: message.msgType,
        content: message.content,
        uuid: config.uuid,
      });
      return { status: "sent", note: "sent Feishu chat message" };
    }

    throw new Error(`unsupported Feishu surface: ${attempt.surface}`);
  }
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
  if (!eventType || !(config.eventTypes ?? DEFAULT_EVENT_TYPES).includes(eventType)) {
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

function parseFeishuSourceConfig(source: SubscriptionSource): FeishuBotSourceConfig {
  const config = source.config ?? {};
  return {
    endpoint: asString(config.endpoint) ?? FEISHU_OPENAPI_ENDPOINT,
    schemaUrl: asString(config.schemaUrl) ?? FEISHU_IM_SCHEMA_URL,
    uxcAuth: asString(config.uxcAuth) ?? source.configRef ?? asString(config.credentialRef) ?? undefined,
    eventTypes: asStringArray(config.eventTypes) ?? DEFAULT_EVENT_TYPES,
    chatIds: asStringArray(config.chatIds) ?? undefined,
  };
}

function parseFeishuCheckpoint(checkpoint: string | null | undefined): FeishuSourceCheckpoint {
  if (!checkpoint) {
    return {};
  }
  try {
    return JSON.parse(checkpoint) as FeishuSourceCheckpoint;
  } catch {
    return {};
  }
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
