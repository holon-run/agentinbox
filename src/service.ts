import {
  Activation,
  ActivationItem,
  AppendSourceEventInput,
  AppendSourceEventResult,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryRequest,
  Inbox,
  InboxItem,
  RegisterSourceInput,
  RegisterSubscriptionInput,
  SourcePollResult,
  Subscription,
  SubscriptionPollResult,
  SubscriptionSource,
} from "./model";
import { AgentInboxStore } from "./store";
import { AdapterRegistry } from "./adapters";
import {
  defaultInboxIdForAgent,
  EventBusBackend,
  SqliteEventBusBackend,
  streamKeyForSource,
  toAppendResult,
} from "./backend";
import { generateId, nowIso } from "./util";
import { matchSubscription } from "./matcher";

const DEFAULT_SUBSCRIPTION_POLL_LIMIT = 100;
const DEFAULT_ACTIVATION_WINDOW_MS = 3_000;
const DEFAULT_ACTIVATION_MAX_ITEMS = 20;
const ACTIVATION_MODES = new Set<Subscription["activationMode"]>(["activation_only", "activation_with_items"]);

interface ActivationBuffer {
  agentId: string;
  inboxId: string;
  activationTarget: string | null;
  activationMode: Subscription["activationMode"];
  pending: Array<{
    subscriptionId: string;
    sourceId: string;
    summary: string;
    item?: ActivationItem;
  }>;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
}

interface ActivationPolicy {
  windowMs?: number;
  maxItems?: number;
}

export class AgentInboxService {
  private readonly backend: EventBusBackend;
  private readonly inFlightSubscriptions = new Set<string>();
  private readonly activationWindowMs: number;
  private readonly activationMaxItems: number;
  private readonly activationBuffers = new Map<string, ActivationBuffer>();
  private subscriptionInterval: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly store: AgentInboxStore,
    private readonly adapters: AdapterRegistry,
    activationDispatcher: ActivationDispatcher = new ActivationDispatcher(),
    backend?: EventBusBackend,
    activationPolicy?: ActivationPolicy,
  ) {
    this.activationDispatcher = activationDispatcher;
    this.backend = backend ?? new SqliteEventBusBackend(store);
    this.activationWindowMs = activationPolicy?.windowMs ?? DEFAULT_ACTIVATION_WINDOW_MS;
    this.activationMaxItems = activationPolicy?.maxItems ?? DEFAULT_ACTIVATION_MAX_ITEMS;
  }

  private readonly activationDispatcher: ActivationDispatcher;

  async start(): Promise<void> {
    if (this.subscriptionInterval) {
      return;
    }
    this.stopping = false;
    this.subscriptionInterval = setInterval(() => {
      void this.syncAllSubscriptions();
    }, 2_000);
    await this.syncAllSubscriptions();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const buffer of this.activationBuffers.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
    }
    if (!this.subscriptionInterval) {
      await this.flushAllPendingActivations();
      return;
    }
    clearInterval(this.subscriptionInterval);
    this.subscriptionInterval = null;
    await this.flushAllPendingActivations();
  }

  async registerSource(input: RegisterSourceInput): Promise<SubscriptionSource> {
    const existing = this.store.getSourceByKey(input.sourceType, input.sourceKey);
    if (existing) {
      return existing;
    }
    const source: SubscriptionSource = {
      sourceId: generateId("src"),
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      configRef: input.configRef ?? null,
      config: input.config ?? {},
      status: "active",
      checkpoint: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.insertSource(source);
    await this.ensureStreamForSource(source);
    await this.adapters.sourceAdapterFor(source.sourceType).ensureSource(source);
    return source;
  }

  async registerSubscription(input: RegisterSubscriptionInput): Promise<Subscription> {
    const source = this.store.getSource(input.sourceId);
    if (!source) {
      throw new Error(`unknown source: ${input.sourceId}`);
    }
    const activationMode = normalizeActivationMode(input.activationMode);

    const inboxId = input.inboxId ?? defaultInboxIdForAgent(input.agentId);
    this.ensureInbox(inboxId, input.agentId);
    const subscription: Subscription = {
      subscriptionId: generateId("sub"),
      agentId: input.agentId,
      sourceId: input.sourceId,
      inboxId,
      matchRules: input.matchRules ?? {},
      activationTarget: input.activationTarget ?? null,
      activationMode,
      startPolicy: input.startPolicy ?? "latest",
      startOffset: input.startOffset ?? null,
      startTime: input.startTime ?? null,
      createdAt: nowIso(),
    };
    this.store.insertSubscription(subscription);

    const stream = await this.ensureStreamForSource(source);
    await this.backend.ensureConsumer({
      streamId: stream.streamId,
      subscriptionId: subscription.subscriptionId,
      consumerKey: `subscription:${subscription.subscriptionId}`,
      startPolicy: subscription.startPolicy,
      startOffset: subscription.startOffset ?? null,
      startTime: subscription.startTime ?? null,
    });
    return subscription;
  }

  async appendSourceEvent(input: AppendSourceEventInput): Promise<AppendSourceEventResult> {
    const source = this.store.getSource(input.sourceId);
    if (!source) {
      throw new Error(`unknown source: ${input.sourceId}`);
    }
    const stream = await this.ensureStreamForSource(source);
    const result = await this.backend.append({
      streamId: stream.streamId,
      events: [input],
    });
    return toAppendResult(result);
  }

  listInboxIds(): string[] {
    return this.store.listInboxes().map((inbox) => inbox.inboxId);
  }

  listInboxItems(inboxId: string): InboxItem[] {
    return this.store.listInboxItems(inboxId);
  }

  ackInboxItems(inboxId: string, itemIds: string[]): { acked: number } {
    return { acked: this.store.ackItems(inboxId, itemIds, nowIso()) };
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    return this.adapters.pollSource(source);
  }

  async pollSubscription(subscriptionId: string): Promise<SubscriptionPollResult> {
    if (this.inFlightSubscriptions.has(subscriptionId)) {
      const subscription = this.store.getSubscription(subscriptionId);
      if (!subscription) {
        throw new Error(`unknown subscription: ${subscriptionId}`);
      }
      return {
        subscriptionId,
        sourceId: subscription.sourceId,
        eventsRead: 0,
        matched: 0,
        inboxItemsCreated: 0,
        committedOffset: null,
        note: "subscription poll already in flight",
      };
    }

    this.inFlightSubscriptions.add(subscriptionId);
    try {
      const subscription = this.store.getSubscription(subscriptionId);
      if (!subscription) {
        throw new Error(`unknown subscription: ${subscriptionId}`);
      }
      const source = this.store.getSource(subscription.sourceId);
      if (!source) {
        throw new Error(`unknown source: ${subscription.sourceId}`);
      }
      const stream = await this.ensureStreamForSource(source);
      const consumer = await this.backend.ensureConsumer({
        streamId: stream.streamId,
        subscriptionId: subscription.subscriptionId,
        consumerKey: `subscription:${subscription.subscriptionId}`,
        startPolicy: subscription.startPolicy,
        startOffset: subscription.startOffset ?? null,
        startTime: subscription.startTime ?? null,
      });
      const batch = await this.backend.read({
        streamId: stream.streamId,
        consumerId: consumer.consumerId,
        limit: DEFAULT_SUBSCRIPTION_POLL_LIMIT,
      });

      let matched = 0;
      let inboxItemsCreated = 0;
      let lastProcessedOffset: number | null = null;
      try {
        for (const event of batch.events) {
          lastProcessedOffset = event.offset;
          const match = matchSubscription(subscription, event.metadata, event.rawPayload);
          if (!match.matched) {
            continue;
          }
          matched += 1;
          const item: InboxItem = {
            itemId: generateId("item"),
            sourceId: event.sourceId,
            sourceNativeId: event.sourceNativeId,
            eventVariant: event.eventVariant,
            inboxId: subscription.inboxId,
            occurredAt: event.occurredAt,
            metadata: { ...event.metadata, matchReason: match.reason, agentId: subscription.agentId },
            rawPayload: event.rawPayload,
            deliveryHandle: event.deliveryHandle as DeliveryHandle | null,
            ackedAt: null,
          };
          const inserted = this.store.insertInboxItem(item);
          if (!inserted) {
            continue;
          }
          inboxItemsCreated += 1;
          this.enqueueActivation({
            agentId: subscription.agentId,
            inboxId: subscription.inboxId,
            activationTarget: subscription.activationTarget ?? null,
            activationMode: subscription.activationMode,
            subscriptionId: subscription.subscriptionId,
            sourceId: source.sourceId,
            eventVariant: event.eventVariant,
            sourceType: source.sourceType,
            sourceKey: source.sourceKey,
            item: {
              itemId: item.itemId,
              sourceId: item.sourceId,
              sourceNativeId: item.sourceNativeId,
              eventVariant: item.eventVariant,
              inboxId: item.inboxId,
              occurredAt: item.occurredAt,
              metadata: item.metadata,
              rawPayload: item.rawPayload,
              deliveryHandle: item.deliveryHandle,
            },
          });
        }
      } catch (error) {
        if (lastProcessedOffset != null) {
          await this.backend.commit({
            consumerId: consumer.consumerId,
            committedOffset: lastProcessedOffset,
          });
        }
        throw error;
      }

      if (lastProcessedOffset != null) {
        await this.backend.commit({
          consumerId: consumer.consumerId,
          committedOffset: lastProcessedOffset,
        });
      }

      return {
        subscriptionId: subscription.subscriptionId,
        sourceId: subscription.sourceId,
        eventsRead: batch.events.length,
        matched,
        inboxItemsCreated,
        committedOffset: lastProcessedOffset,
        note: batch.events.length === 0 ? "no new stream events" : "subscription batch processed",
      };
    } finally {
      this.inFlightSubscriptions.delete(subscriptionId);
    }
  }

  async sendDelivery(request: DeliveryRequest): Promise<DeliveryAttempt & { note: string }> {
    const handle = resolveDeliveryHandle(request);
    const attempt: DeliveryAttempt = {
      deliveryId: generateId("dlv"),
      provider: handle.provider,
      surface: handle.surface,
      targetRef: handle.targetRef,
      threadRef: handle.threadRef ?? null,
      replyMode: handle.replyMode ?? null,
      kind: request.kind,
      payload: request.payload,
      status: "accepted",
      createdAt: nowIso(),
    };
    const adapter = this.adapters.deliveryAdapterFor(handle.provider);
    const result = await adapter.send(request, attempt);
    const storedAttempt = { ...attempt, status: result.status };
    this.store.insertDelivery(storedAttempt);
    return { ...storedAttempt, note: result.note };
  }

  status(): Record<string, unknown> {
    return {
      counts: this.store.getCounts(),
      sources: this.store.listSources(),
      subscriptions: this.store.listSubscriptions(),
      inboxes: this.store.listInboxes(),
      streams: this.store.listStreams(),
      consumers: this.store.listConsumers(),
      adapters: this.adapters.status(),
      recentActivations: this.store.listActivations().slice(0, 10),
      recentDeliveries: this.store.listDeliveries().slice(0, 10),
    };
  }

  private ensureInbox(inboxId: string, ownerAgentId: string): Inbox {
    const existing = this.store.getInbox(inboxId);
    if (existing) {
      if (existing.ownerAgentId !== ownerAgentId) {
        throw new Error(`inbox ${inboxId} already belongs to agent ${existing.ownerAgentId}`);
      }
      return existing;
    }
    const inbox: Inbox = {
      inboxId,
      ownerAgentId,
      createdAt: nowIso(),
    };
    this.store.insertInbox(inbox);
    return inbox;
  }

  private async ensureStreamForSource(source: SubscriptionSource) {
    return this.backend.ensureStream({
      sourceId: source.sourceId,
      streamKey: streamKeyForSource(source.sourceType, source.sourceKey),
      backend: "sqlite",
    });
  }

  private async syncAllSubscriptions(): Promise<void> {
    const subscriptions = this.store.listSubscriptions();
    for (const subscription of subscriptions) {
      try {
        await this.pollSubscription(subscription.subscriptionId);
      } catch (error) {
        console.warn(`subscription poll failed for ${subscription.subscriptionId}:`, error);
      }
    }
  }

  private enqueueActivation(input: {
    agentId: string;
    inboxId: string;
    activationTarget: string | null;
    activationMode: Subscription["activationMode"];
    subscriptionId: string;
    sourceId: string;
    eventVariant: string;
    sourceType: string;
    sourceKey: string;
    item: ActivationItem;
  }): void {
    const key = activationBufferKey(input.inboxId, input.activationTarget, input.activationMode);
    let buffer = this.activationBuffers.get(key);
    if (!buffer) {
      buffer = {
        agentId: input.agentId,
        inboxId: input.inboxId,
        activationTarget: input.activationTarget,
        activationMode: input.activationMode,
        pending: [],
        timer: null,
        inFlight: false,
      };
      this.activationBuffers.set(key, buffer);
    }

    buffer.pending.push({
      subscriptionId: input.subscriptionId,
      sourceId: input.sourceId,
      summary: `${input.sourceType}:${input.sourceKey}:${input.eventVariant}`,
      item: input.activationMode === "activation_with_items" ? input.item : undefined,
    });

    if (!buffer.timer && !buffer.inFlight) {
      buffer.timer = setTimeout(() => {
        void this.flushActivationBuffer(key);
      }, this.activationWindowMs);
    }

    if (buffer.pending.length >= this.activationMaxItems) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      void this.flushActivationBuffer(key);
    }
  }

  private async flushAllPendingActivations(): Promise<void> {
    const keys = Array.from(this.activationBuffers.keys());
    for (const key of keys) {
      await this.flushActivationBuffer(key);
    }
  }

  private async flushActivationBuffer(key: string): Promise<void> {
    const buffer = this.activationBuffers.get(key);
    if (!buffer || buffer.inFlight || buffer.pending.length === 0) {
      return;
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    buffer.inFlight = true;
    const dispatchedEntries = buffer.pending.splice(0, buffer.pending.length);
    try {
      const dispatchedCount = dispatchedEntries.length;
      const dispatchedSubscriptionIds = Array.from(new Set(dispatchedEntries.map((entry) => entry.subscriptionId))).sort();
      const dispatchedSourceIds = Array.from(new Set(dispatchedEntries.map((entry) => entry.sourceId))).sort();
      const dispatchedSummary = dispatchedEntries[0]?.summary ?? null;
      const dispatchedItems = buffer.activationMode === "activation_with_items"
        ? dispatchedEntries
          .map((entry) => entry.item)
          .filter((item): item is ActivationItem => Boolean(item))
        : undefined;
      const activation: Activation = {
        kind: "agentinbox.activation",
        activationId: generateId("act"),
        agentId: buffer.agentId,
        inboxId: buffer.inboxId,
        subscriptionIds: dispatchedSubscriptionIds,
        sourceIds: dispatchedSourceIds,
        newItemCount: dispatchedCount,
        summary: summarizeActivation(buffer.inboxId, dispatchedCount, dispatchedSummary),
        items: dispatchedItems && dispatchedItems.length > 0 ? dispatchedItems : undefined,
        createdAt: nowIso(),
        deliveredAt: null,
      };
      await this.activationDispatcher.dispatch(buffer.activationTarget, activation);
      this.store.insertActivation(activation);

      const hasPendingDuringFlight = buffer.pending.length > 0;
      buffer.inFlight = false;

      if (hasPendingDuringFlight) {
        buffer.timer = setTimeout(() => {
          void this.flushActivationBuffer(key);
        }, this.activationWindowMs);
        return;
      }

      this.activationBuffers.delete(key);
    } catch (error) {
      buffer.pending.unshift(...dispatchedEntries);
      buffer.inFlight = false;
      if (!this.stopping && !buffer.timer) {
        buffer.timer = setTimeout(() => {
          void this.flushActivationBuffer(key);
        }, this.activationWindowMs);
      }
      throw error;
    }
  }
}

function resolveDeliveryHandle(request: DeliveryRequest): DeliveryHandle {
  if (request.deliveryHandle) {
    return request.deliveryHandle;
  }
  if (!request.provider || !request.surface || !request.targetRef) {
    throw new Error("delivery requires either deliveryHandle or provider/surface/targetRef");
  }
  return {
    provider: request.provider,
    surface: request.surface,
    targetRef: request.targetRef,
    threadRef: request.threadRef ?? null,
    replyMode: request.replyMode ?? null,
  };
}

export class ActivationDispatcher {
  async dispatch(target: string | null | undefined, activation: Activation): Promise<void> {
    if (!target) {
      return;
    }
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activation),
      });
      if (!response.ok) {
        console.warn(`activation dispatch failed for ${target}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`activation dispatch error for ${target}:`, error);
    }
  }
}

function activationBufferKey(
  inboxId: string,
  activationTarget: string | null,
  activationMode: Subscription["activationMode"],
): string {
  return `${inboxId}::${activationTarget ?? ""}::${activationMode}`;
}

function summarizeActivation(inboxId: string, newItemCount: number, firstSummary: string | null): string {
  const itemWord = newItemCount === 1 ? "item" : "items";
  if (firstSummary) {
    return `${newItemCount} new ${itemWord} in ${inboxId} from ${firstSummary}`;
  }
  return `${newItemCount} new ${itemWord} in ${inboxId}`;
}

function normalizeActivationMode(mode: RegisterSubscriptionInput["activationMode"]): Subscription["activationMode"] {
  const resolved = mode ?? "activation_only";
  if (!ACTIVATION_MODES.has(resolved)) {
    throw new Error(`unsupported activation mode: ${String(mode)}`);
  }
  return resolved;
}
