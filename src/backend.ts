import {
  AppendSourceEventInput,
  AppendSourceEventResult,
  SubscriptionStartPolicy,
} from "./model";
import { AgentInboxStore } from "./store";
import { generateCanonicalId, nowIso } from "./util";

export interface StreamRecord {
  streamId: string;
  sourceId: string;
  streamKey: string;
  backend: string;
  createdAt: string;
}

export interface StreamEventRecord {
  offset: number;
  streamEventId: string;
  streamId: string;
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  deliveryHandle: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConsumerRecord {
  consumerId: string;
  streamId: string;
  subscriptionId: string;
  consumerKey: string;
  nextOffset: number;
  startPolicy: SubscriptionStartPolicy;
  startOffset: number | null;
  startTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StreamStats {
  streamId: string;
  eventCount: number;
  highWatermarkOffset: number | null;
}

export interface ConsumerLag {
  consumerId: string;
  streamId: string;
  pendingEvents: number;
  highWatermarkOffset: number | null;
  nextOffset: number;
}

export interface EnsureStreamInput {
  sourceId: string;
  streamKey: string;
  backend: string;
}

export interface AppendEventsInput {
  streamId: string;
  events: AppendSourceEventInput[];
}

export interface AppendEventsResult {
  appended: number;
  deduped: number;
  lastOffset: number | null;
}

export interface EnsureConsumerInput {
  streamId: string;
  subscriptionId: string;
  consumerKey: string;
  startPolicy: SubscriptionStartPolicy;
  startOffset?: number | null;
  startTime?: string | null;
}

export interface GetConsumerInput {
  subscriptionId?: string;
  consumerId?: string;
}

export interface ReadEventsInput {
  streamId: string;
  consumerId: string;
  limit: number;
}

export interface ReadEventsResult {
  consumer: ConsumerRecord;
  events: StreamEventRecord[];
  highWatermarkOffset: number | null;
}

export interface CommitOffsetInput {
  consumerId: string;
  committedOffset: number;
}

export interface CommitOffsetResult {
  consumer: ConsumerRecord;
  committedOffset: number;
}

export interface ResetConsumerInput {
  consumerId: string;
  startPolicy: SubscriptionStartPolicy;
  startOffset?: number | null;
  startTime?: string | null;
}

export interface EventBusBackend {
  ensureStream(input: EnsureStreamInput): Promise<StreamRecord>;
  append(input: AppendEventsInput): Promise<AppendEventsResult>;
  ensureConsumer(input: EnsureConsumerInput): Promise<ConsumerRecord>;
  getConsumer(input: GetConsumerInput): Promise<ConsumerRecord | null>;
  deleteConsumer(input: GetConsumerInput): Promise<{ removed: boolean }>;
  read(input: ReadEventsInput): Promise<ReadEventsResult>;
  commit(input: CommitOffsetInput): Promise<CommitOffsetResult>;
  reset(input: ResetConsumerInput): Promise<ConsumerRecord>;
  getStreamStats(streamId: string): Promise<StreamStats>;
  getConsumerLag(input: GetConsumerInput): Promise<ConsumerLag>;
}

export class SqliteEventBusBackend implements EventBusBackend {
  constructor(private readonly store: AgentInboxStore) {}

  async ensureStream(input: EnsureStreamInput): Promise<StreamRecord> {
    const existing = this.store.getStreamBySourceId(input.sourceId);
    if (existing) {
      return existing;
    }
    const stream: StreamRecord = {
      streamId: generateCanonicalId("str"),
      sourceId: input.sourceId,
      streamKey: input.streamKey,
      backend: input.backend,
      createdAt: nowIso(),
    };
    this.store.insertStream(stream);
    return stream;
  }

  async append(input: AppendEventsInput): Promise<AppendEventsResult> {
    let appended = 0;
    let deduped = 0;
    let lastOffset: number | null = null;
    for (const event of input.events) {
      const result = this.store.insertStreamEvent(input.streamId, event);
      appended += result.appended;
      deduped += result.deduped;
      lastOffset = result.lastOffset ?? lastOffset;
    }
    return { appended, deduped, lastOffset };
  }

  async ensureConsumer(input: EnsureConsumerInput): Promise<ConsumerRecord> {
    const existing = this.store.getConsumerBySubscriptionId(input.subscriptionId);
    if (existing) {
      return existing;
    }
    const nextOffset = this.resolveInitialOffset(
      input.streamId,
      input.startPolicy,
      input.startOffset ?? null,
      input.startTime ?? null,
    );
    const consumer: ConsumerRecord = {
      consumerId: generateCanonicalId("con"),
      streamId: input.streamId,
      subscriptionId: input.subscriptionId,
      consumerKey: input.consumerKey,
      nextOffset,
      startPolicy: input.startPolicy,
      startOffset: input.startOffset ?? null,
      startTime: input.startTime ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.insertConsumer(consumer);
    return consumer;
  }

  async getConsumer(input: GetConsumerInput): Promise<ConsumerRecord | null> {
    if (input.consumerId) {
      return this.store.getConsumer(input.consumerId);
    }
    if (input.subscriptionId) {
      return this.store.getConsumerBySubscriptionId(input.subscriptionId);
    }
    throw new Error("getConsumer requires consumerId or subscriptionId");
  }

  async deleteConsumer(input: GetConsumerInput): Promise<{ removed: boolean }> {
    const consumer = await this.getConsumer(input);
    if (!consumer) {
      return { removed: false };
    }
    this.store.deleteConsumer(consumer.consumerId);
    return { removed: true };
  }

  async read(input: ReadEventsInput): Promise<ReadEventsResult> {
    const consumer = this.store.getConsumer(input.consumerId);
    if (!consumer) {
      throw new Error(`unknown consumer: ${input.consumerId}`);
    }
    const events = this.store.readStreamEvents(input.streamId, consumer.nextOffset, input.limit);
    const stats = this.store.getStreamStats(input.streamId);
    return {
      consumer,
      events,
      highWatermarkOffset: stats.highWatermarkOffset,
    };
  }

  async commit(input: CommitOffsetInput): Promise<CommitOffsetResult> {
    const consumer = this.store.getConsumer(input.consumerId);
    if (!consumer) {
      throw new Error(`unknown consumer: ${input.consumerId}`);
    }
    const nextOffset = input.committedOffset + 1;
    const updated = this.store.updateConsumerOffset(input.consumerId, nextOffset, input.committedOffset);
    return {
      consumer: updated,
      committedOffset: input.committedOffset,
    };
  }

  async reset(input: ResetConsumerInput): Promise<ConsumerRecord> {
    const consumer = this.store.getConsumer(input.consumerId);
    if (!consumer) {
      throw new Error(`unknown consumer: ${input.consumerId}`);
    }
    const nextOffset = this.resolveInitialOffset(
      consumer.streamId,
      input.startPolicy,
      input.startOffset ?? null,
      input.startTime ?? null,
    );
    return this.store.resetConsumer(consumer.consumerId, {
      startPolicy: input.startPolicy,
      startOffset: input.startOffset ?? null,
      startTime: input.startTime ?? null,
      nextOffset,
    });
  }

  async getStreamStats(streamId: string): Promise<StreamStats> {
    return this.store.getStreamStats(streamId);
  }

  async getConsumerLag(input: GetConsumerInput): Promise<ConsumerLag> {
    const consumer = await this.getConsumer(input);
    if (!consumer) {
      throw new Error("unknown consumer");
    }
    const stats = this.store.getStreamStats(consumer.streamId);
    const pendingEvents = this.store.countPendingEvents(consumer.streamId, consumer.nextOffset);
    return {
      consumerId: consumer.consumerId,
      streamId: consumer.streamId,
      pendingEvents,
      highWatermarkOffset: stats.highWatermarkOffset,
      nextOffset: consumer.nextOffset,
    };
  }

  private resolveInitialOffset(
    streamId: string,
    startPolicy: SubscriptionStartPolicy,
    startOffset: number | null,
    startTime: string | null,
  ): number {
    const stats = this.store.getStreamStats(streamId);
    if (startPolicy === "latest") {
      return (stats.highWatermarkOffset ?? 0) + 1;
    }
    if (startPolicy === "earliest") {
      return 1;
    }
    if (startPolicy === "at_offset") {
      return Math.max(1, startOffset ?? 1);
    }
    if (startPolicy === "at_time") {
      if (!startTime) {
        throw new Error("at_time start policy requires startTime");
      }
      return this.store.findOffsetAtOrAfter(streamId, startTime) ?? ((stats.highWatermarkOffset ?? 0) + 1);
    }
    throw new Error(`unsupported start policy: ${String(startPolicy)}`);
  }
}

export function streamKeyForSource(sourceId: string): string {
  return `source:${sourceId}`;
}

export function toAppendResult(result: AppendEventsResult): AppendSourceEventResult {
  return {
    appended: result.appended,
    deduped: result.deduped,
    lastOffset: result.lastOffset,
  };
}
