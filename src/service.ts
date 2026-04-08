import {
  Activation,
  ActivationItem,
  ActivationTarget,
  AddWebhookActivationTargetInput,
  Agent,
  AppendSourceEventInput,
  AppendSourceEventResult,
  DeliveryAttempt,
  DeliveryHandle,
  DeliveryRequest,
  Inbox,
  InboxItem,
  InboxWatchEvent,
  RegisterAgentInput,
  RegisterAgentResult,
  RegisterSourceInput,
  RegisterSubscriptionInput,
  SourceSchema,
  SourcePollResult,
  Subscription,
  SubscriptionPollResult,
  SubscriptionSource,
  TerminalActivationTarget,
  WatchInboxOptions,
  WebhookActivationTarget,
} from "./model";
import { AgentInboxStore } from "./store";
import { AdapterRegistry } from "./adapters";
import {
  ConsumerLag,
  EventBusBackend,
  SqliteEventBusBackend,
  defaultInboxIdForAgent,
  streamKeyForSource,
  toAppendResult,
} from "./backend";
import { generateId, nowIso } from "./util";
import { getSourceSchema } from "./source_schema";
import { matchSubscriptionFilter, validateSubscriptionFilter } from "./filter";
import { assignedAgentIdFromContext, detectTerminalContext, renderAgentPrompt, TerminalDispatcher } from "./terminal";

const DEFAULT_SUBSCRIPTION_POLL_LIMIT = 100;
const DEFAULT_ACTIVATION_WINDOW_MS = 3_000;
const DEFAULT_ACTIVATION_MAX_ITEMS = 20;
const DEFAULT_NOTIFY_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_NOTIFY_RETRY_MS = 5_000;
const DEFAULT_ACKED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_AGENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GC_INTERVAL_MS = 60 * 1000;
const WEBHOOK_ACTIVATION_MODES = new Set<WebhookActivationTarget["mode"]>(["activation_only", "activation_with_items"]);
const SUBSCRIPTION_START_POLICIES = new Set<Subscription["startPolicy"]>(["latest", "earliest", "at_offset", "at_time"]);
const SUBSCRIPTION_LIFECYCLE_MODES = new Set<Subscription["lifecycleMode"]>(["standing", "temporary"]);

interface ActivationPolicy {
  windowMs?: number;
  maxItems?: number;
}

interface BufferedNotification {
  agentId: string;
  targetId: string;
  pending: Array<{
    subscriptionId: string;
    sourceId: string;
    summary: string;
    item: ActivationItem;
  }>;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
}

interface InboxWatcher {
  onItems(items: InboxItem[]): void;
}

type ActivationDispatchOutcome = "dispatched" | "retryable_failure" | "offline";

export interface InboxWatchSession {
  initialItems: InboxItem[];
  start(): void;
  close(): void;
}

export class AgentInboxService {
  private readonly backend: EventBusBackend;
  private readonly inFlightSubscriptions = new Set<string>();
  private readonly activationWindowMs: number;
  private readonly activationMaxItems: number;
  private readonly ackedRetentionMs: number;
  private readonly notificationBuffers = new Map<string, BufferedNotification>();
  private readonly inboxWatchers = new Map<string, Set<InboxWatcher>>();
  private syncInterval: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastAckedInboxGcAt = 0;
  private lastOfflineAgentGcAt = 0;

  constructor(
    private readonly store: AgentInboxStore,
    private readonly adapters: AdapterRegistry,
    activationDispatcher: ActivationDispatcher = new ActivationDispatcher(),
    backend?: EventBusBackend,
    activationPolicy?: ActivationPolicy,
    terminalDispatcher: TerminalDispatcher = new TerminalDispatcher(),
  ) {
    this.activationDispatcher = activationDispatcher;
    this.backend = backend ?? new SqliteEventBusBackend(store);
    this.activationWindowMs = activationPolicy?.windowMs ?? DEFAULT_ACTIVATION_WINDOW_MS;
    this.activationMaxItems = activationPolicy?.maxItems ?? DEFAULT_ACTIVATION_MAX_ITEMS;
    this.ackedRetentionMs = DEFAULT_ACKED_RETENTION_MS;
    this.terminalDispatcher = terminalDispatcher;
  }

  private readonly activationDispatcher: ActivationDispatcher;
  private readonly terminalDispatcher: TerminalDispatcher;

  async start(): Promise<void> {
    if (this.syncInterval) {
      return;
    }
    this.stopping = false;
    this.syncInterval = setInterval(() => {
      void this.syncAllSubscriptions();
      void this.syncActivationDispatchStates();
      void this.runAckedInboxGcIfDue();
      void this.syncLifecycleGc();
    }, 2_000);
    await this.syncAllSubscriptions();
    await this.syncActivationDispatchStates();
    await this.runAckedInboxGcIfDue(true);
    await this.syncLifecycleGc();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const buffer of this.notificationBuffers.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    await this.flushAllPendingNotifications();
  }

  async registerSource(input: RegisterSourceInput): Promise<SubscriptionSource> {
    const existing = this.store.getSourceByKey(input.sourceType, input.sourceKey);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    const source: SubscriptionSource = {
      sourceId: generateId("src"),
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      configRef: input.configRef ?? null,
      config: input.config ?? {},
      status: "active",
      checkpoint: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSource(source);
    await this.ensureStreamForSource(source);
    await this.adapters.sourceAdapterFor(source.sourceType).ensureSource(source);
    return source;
  }

  listSources(): SubscriptionSource[] {
    return this.store.listSources();
  }

  getSource(sourceId: string): SubscriptionSource {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    return source;
  }

  getSourceDetails(sourceId: string): Record<string, unknown> {
    const source = this.getSource(sourceId);
    return {
      source,
      schema: getSourceSchema(source.sourceType),
      stream: this.store.getStreamBySourceId(sourceId),
      subscriptions: this.store.listSubscriptionsForSource(sourceId),
    };
  }

  getSourceSchema(sourceType: SubscriptionSource["sourceType"]): SourceSchema {
    return getSourceSchema(sourceType);
  }

  registerAgent(input: RegisterAgentInput): RegisterAgentResult {
    validateNotifyLeaseMs(input.notifyLeaseMs);
    validateTerminalRegistration(input);

    const runtimeKind = input.runtimeKind ?? "unknown";
    const agentId = assignedAgentIdFromContext({
      runtimeKind,
      runtimeSessionId: input.runtimeSessionId ?? null,
      backend: input.backend,
      tmuxPaneId: input.tmuxPaneId ?? null,
      itermSessionId: input.itermSessionId ?? null,
      tty: input.tty ?? null,
    });
    const now = nowIso();
    const existingAgent = this.store.getAgent(agentId);
    const agent = existingAgent
      ? this.store.updateAgent(agentId, {
          status: "active",
          offlineSince: null,
          runtimeKind,
          runtimeSessionId: input.runtimeSessionId ?? null,
          updatedAt: now,
          lastSeenAt: now,
        })
      : (() => {
          const created: Agent = {
            agentId,
            status: "active",
            offlineSince: null,
            runtimeKind,
            runtimeSessionId: input.runtimeSessionId ?? null,
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
          };
          this.store.insertAgent(created);
          return created;
        })();

    const terminalTarget = this.upsertTerminalActivationTarget(agent.agentId, input, now);
    const inbox = this.ensureInboxForAgent(agent.agentId);
    return {
      agent,
      terminalTarget,
      inbox,
    };
  }

  detectAndRegisterAgent(notifyLeaseMs?: number | null, env: NodeJS.ProcessEnv = process.env): RegisterAgentResult {
    const detected = detectTerminalContext(env);
    return this.registerAgent({
      runtimeKind: detected.runtimeKind,
      runtimeSessionId: detected.runtimeSessionId ?? null,
      backend: detected.backend,
      mode: "agent_prompt",
      tmuxPaneId: detected.tmuxPaneId ?? null,
      tty: detected.tty ?? null,
      termProgram: detected.termProgram ?? null,
      itermSessionId: detected.itermSessionId ?? null,
      notifyLeaseMs: notifyLeaseMs ?? null,
    });
  }

  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  getAgent(agentId: string): Agent {
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      throw new Error(`unknown agent: ${agentId}`);
    }
    return agent;
  }

  getAgentDetails(agentId: string): Record<string, unknown> {
    const agent = this.getAgent(agentId);
    return {
      agent,
      inbox: this.ensureInboxForAgent(agent.agentId),
      subscriptions: this.store.listSubscriptionsForAgent(agent.agentId),
      activationTargets: this.store.listActivationTargetsForAgent(agent.agentId),
      activationDispatchStates: this.store.listActivationDispatchStatesForAgent(agent.agentId),
      itemCounts: this.inboxCounts(agent.agentId),
    };
  }

  removeAgent(agentId: string): { removed: boolean } {
    this.getAgent(agentId);
    this.store.deleteAgent(agentId);
    this.notificationBuffers.forEach((buffer, key) => {
      if (key.startsWith(`${agentId}:`)) {
        if (buffer.timer) {
          clearTimeout(buffer.timer);
        }
        this.notificationBuffers.delete(key);
      }
    });
    this.inboxWatchers.delete(agentId);
    return { removed: true };
  }

  addWebhookActivationTarget(agentId: string, input: AddWebhookActivationTargetInput): WebhookActivationTarget {
    this.getAgent(agentId);
    validateNotifyLeaseMs(input.notifyLeaseMs);
    const mode = normalizeWebhookActivationMode(input.activationMode);
    const now = nowIso();
    const target: WebhookActivationTarget = {
      targetId: generateId("tgt"),
      agentId,
      kind: "webhook",
      status: "active",
      offlineSince: null,
      consecutiveFailures: 0,
      lastDeliveredAt: null,
      lastError: null,
      mode,
      url: input.url,
      notifyLeaseMs: input.notifyLeaseMs ?? DEFAULT_NOTIFY_LEASE_MS,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.store.insertActivationTarget(target);
    this.markAgentActive(agentId);
    return target;
  }

  listActivationTargets(agentId?: string): ActivationTarget[] {
    if (agentId) {
      this.getAgent(agentId);
      return this.store.listActivationTargetsForAgent(agentId);
    }
    return this.store.listActivationTargets();
  }

  getActivationTarget(targetId: string): ActivationTarget {
    const target = this.store.getActivationTarget(targetId);
    if (!target) {
      throw new Error(`unknown activation target: ${targetId}`);
    }
    return target;
  }

  removeActivationTarget(agentId: string, targetId: string): { removed: boolean } {
    const target = this.getActivationTarget(targetId);
    if (target.agentId !== agentId) {
      throw new Error(`activation target ${targetId} does not belong to agent ${agentId}`);
    }
    this.store.deleteActivationTarget(agentId, targetId);
    this.reconcileAgentStatus(agentId);
    return { removed: true };
  }

  async registerSubscription(input: RegisterSubscriptionInput): Promise<Subscription> {
    this.getAgent(input.agentId);
    const source = this.store.getSource(input.sourceId);
    if (!source) {
      throw new Error(`unknown source: ${input.sourceId}`);
    }
    await validateSubscriptionFilter(input.filter ?? {});
    const lifecycleMode = input.lifecycleMode ?? "standing";
    if (!SUBSCRIPTION_LIFECYCLE_MODES.has(lifecycleMode)) {
      throw new Error(`unsupported lifecycle mode: ${lifecycleMode}`);
    }
    const subscription: Subscription = {
      subscriptionId: generateId("sub"),
      agentId: input.agentId,
      sourceId: input.sourceId,
      filter: input.filter ?? {},
      lifecycleMode,
      expiresAt: input.expiresAt ?? null,
      startPolicy: input.startPolicy ?? "latest",
      startOffset: input.startOffset ?? null,
      startTime: input.startTime ?? null,
      createdAt: nowIso(),
    };
    this.ensureInboxForAgent(subscription.agentId);
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

  async removeSubscription(subscriptionId: string): Promise<{ removed: boolean; subscriptionId: string }> {
    const subscription = this.getSubscription(subscriptionId);
    await this.backend.deleteConsumer({ subscriptionId });
    this.store.deleteSubscription(subscriptionId);
    this.clearSubscriptionRuntimeState(subscription);
    return { removed: true, subscriptionId };
  }

  listSubscriptions(filters?: {
    sourceId?: string;
    agentId?: string;
  }): Subscription[] {
    return this.store.listSubscriptions().filter((subscription) => {
      if (filters?.sourceId && subscription.sourceId !== filters.sourceId) {
        return false;
      }
      if (filters?.agentId && subscription.agentId !== filters.agentId) {
        return false;
      }
      return true;
    });
  }

  getSubscription(subscriptionId: string): Subscription {
    const subscription = this.store.getSubscription(subscriptionId);
    if (!subscription) {
      throw new Error(`unknown subscription: ${subscriptionId}`);
    }
    return subscription;
  }

  async getSubscriptionDetails(subscriptionId: string): Promise<Record<string, unknown>> {
    const subscription = this.getSubscription(subscriptionId);
    const consumer = await this.backend.getConsumer({ subscriptionId });
    if (!consumer) {
      throw new Error(`unknown consumer for subscription: ${subscriptionId}`);
    }
    return {
      subscription,
      source: this.getSource(subscription.sourceId),
      inbox: this.ensureInboxForAgent(subscription.agentId),
      activationTargets: this.store.listActivationTargetsForAgent(subscription.agentId),
      consumer,
      lag: await this.backend.getConsumerLag({ consumerId: consumer.consumerId }),
    };
  }

  async getSubscriptionLag(subscriptionId: string): Promise<ConsumerLag> {
    this.getSubscription(subscriptionId);
    return this.backend.getConsumerLag({ subscriptionId });
  }

  async resetSubscription(input: {
    subscriptionId: string;
    startPolicy: Subscription["startPolicy"];
    startOffset?: number | null;
    startTime?: string | null;
  }): Promise<Record<string, unknown>> {
    this.getSubscription(input.subscriptionId);
    if (!SUBSCRIPTION_START_POLICIES.has(input.startPolicy)) {
      throw new Error(`unsupported start policy: ${input.startPolicy}`);
    }
    const consumer = await this.backend.getConsumer({ subscriptionId: input.subscriptionId });
    if (!consumer) {
      throw new Error(`unknown consumer for subscription: ${input.subscriptionId}`);
    }
    const reset = await this.backend.reset({
      consumerId: consumer.consumerId,
      startPolicy: input.startPolicy,
      startOffset: input.startOffset ?? null,
      startTime: input.startTime ?? null,
    });
    return {
      subscription: this.getSubscription(input.subscriptionId),
      consumer: reset,
      lag: await this.backend.getConsumerLag({ consumerId: reset.consumerId }),
    };
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

  async appendSourceEventByCaller(sourceId: string, input: Omit<AppendSourceEventInput, "sourceId">): Promise<AppendSourceEventResult> {
    const source = this.getSource(sourceId);
    if (source.sourceType !== "custom") {
      throw new Error(`manual append is not supported for source type: ${source.sourceType}`);
    }
    return this.appendSourceEvent({ ...input, sourceId });
  }

  async appendFixtureEvent(sourceId: string, input: Omit<AppendSourceEventInput, "sourceId">): Promise<AppendSourceEventResult> {
    const source = this.getSource(sourceId);
    if (source.sourceType !== "fixture") {
      throw new Error(`fixtures/emit requires fixture source, received: ${source.sourceType}`);
    }
    return this.appendSourceEvent({ ...input, sourceId });
  }

  listInboxAgentIds(): string[] {
    return this.store.listInboxes().map((inbox) => inbox.ownerAgentId);
  }

  getInboxDetailsByAgent(agentId: string): Record<string, unknown> {
    const inbox = this.ensureInboxForAgent(agentId);
    return {
      agent: this.getAgent(agentId),
      inbox,
      subscriptions: this.store.listSubscriptionsForAgent(agentId),
      activationTargets: this.store.listActivationTargetsForAgent(agentId),
      activationDispatchStates: this.store.listActivationDispatchStatesForAgent(agentId),
      itemCounts: this.inboxCounts(agentId),
    };
  }

  listInboxItems(agentId: string, options?: WatchInboxOptions): InboxItem[] {
    return this.store.listInboxItems(this.ensureInboxForAgent(agentId).inboxId, options);
  }

  watchInbox(
    agentId: string,
    options: WatchInboxOptions,
    onEvent: (event: InboxWatchEvent) => void,
  ): InboxWatchSession {
    const inbox = this.ensureInboxForAgent(agentId);
    const pendingItems: InboxItem[] = [];
    let started = false;

    const emitItems = (items: InboxItem[]) => {
      if (items.length === 0) {
        return;
      }
      onEvent({
        event: "items",
        agentId,
        items,
      });
    };

    const watcher: InboxWatcher = {
      onItems: (items) => {
        if (!started) {
          pendingItems.push(...items);
          return;
        }
        emitItems(items);
      },
    };

    let watchers = this.inboxWatchers.get(agentId);
    if (!watchers) {
      watchers = new Set();
      this.inboxWatchers.set(agentId, watchers);
    }
    watchers.add(watcher);

    let initialItems: InboxItem[];
    try {
      initialItems = this.store.listInboxItems(inbox.inboxId, {
        afterItemId: options.afterItemId,
        includeAcked: options.includeAcked ?? false,
      });
    } catch (error) {
      watchers.delete(watcher);
      if (watchers.size === 0) {
        this.inboxWatchers.delete(agentId);
      }
      throw error;
    }

    const initialItemIds = new Set(initialItems.map((item) => item.itemId));
    return {
      initialItems,
      start: () => {
        if (started) {
          return;
        }
        started = true;
        const replayItems = pendingItems.filter((item) => !initialItemIds.has(item.itemId));
        pendingItems.length = 0;
        emitItems(replayItems);
      },
      close: () => {
        const activeWatchers = this.inboxWatchers.get(agentId);
        if (!activeWatchers) {
          return;
        }
        activeWatchers.delete(watcher);
        if (activeWatchers.size === 0) {
          this.inboxWatchers.delete(agentId);
        }
      },
    };
  }

  ackInboxItems(agentId: string, itemIds: string[]): { acked: number } {
    const inbox = this.ensureInboxForAgent(agentId);
    const acked = this.store.ackItems(inbox.inboxId, itemIds, nowIso());
    if (acked > 0) {
      void this.handleInboxAckEffects(agentId);
    }
    return { acked };
  }

  ackInboxItemsThrough(agentId: string, itemId: string): { acked: number } {
    const inbox = this.ensureInboxForAgent(agentId);
    const acked = this.store.ackItemsThrough(inbox.inboxId, itemId, nowIso());
    if (acked > 0) {
      void this.handleInboxAckEffects(agentId);
    }
    return { acked };
  }

  ackAllInboxItems(agentId: string): { acked: number } {
    const inbox = this.ensureInboxForAgent(agentId);
    const itemIds = this.store.listInboxItems(inbox.inboxId, { includeAcked: false }).map((item) => item.itemId);
    const acked = this.store.ackItems(inbox.inboxId, itemIds, nowIso());
    if (acked > 0) {
      void this.handleInboxAckEffects(agentId);
    }
    return { acked };
  }

  compactInbox(agentId: string): { deleted: number; retentionMs: number } {
    const inbox = this.ensureInboxForAgent(agentId);
    return {
      deleted: this.store.deleteAckedInboxItems(inbox.inboxId, retentionCutoffIso(this.ackedRetentionMs)),
      retentionMs: this.ackedRetentionMs,
    };
  }

  gcAckedInboxItems(): { deleted: number; retentionMs: number } {
    return {
      deleted: this.store.deleteAckedInboxItemsGlobal(retentionCutoffIso(this.ackedRetentionMs)),
      retentionMs: this.ackedRetentionMs,
    };
  }

  gc(): { deleted: number; retentionMs: number; removedAgents: number } {
    const acked = this.gcAckedInboxItems();
    const lifecycle = this.gcOfflineAgents();
    return {
      deleted: acked.deleted,
      retentionMs: acked.retentionMs,
      removedAgents: lifecycle.removedAgents,
    };
  }

  async pollSource(sourceId: string): Promise<SourcePollResult> {
    return this.adapters.pollSource(this.getSource(sourceId));
  }

  async pollSubscription(subscriptionId: string): Promise<SubscriptionPollResult> {
    if (this.inFlightSubscriptions.has(subscriptionId)) {
      const subscription = this.getSubscription(subscriptionId);
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
      const subscription = this.getSubscription(subscriptionId);
      const source = this.getSource(subscription.sourceId);
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

      const inbox = this.ensureInboxForAgent(subscription.agentId);
      const targets = this.store.listActivationTargetsForAgent(subscription.agentId).filter((target) => target.status === "active");
      let matched = 0;
      let inboxItemsCreated = 0;
      let lastProcessedOffset: number | null = null;
      const insertedItems: InboxItem[] = [];
      try {
        for (const event of batch.events) {
          lastProcessedOffset = event.offset;
          const match = await matchSubscriptionFilter(subscription.filter, {
            metadata: event.metadata,
            payload: event.rawPayload,
            eventVariant: event.eventVariant,
            sourceType: source.sourceType,
            sourceKey: source.sourceKey,
          });
          if (!match.matched) {
            continue;
          }
          matched += 1;
          const item: InboxItem = {
            itemId: generateId("item"),
            sourceId: event.sourceId,
            sourceNativeId: event.sourceNativeId,
            eventVariant: event.eventVariant,
            inboxId: inbox.inboxId,
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
          insertedItems.push(item);

          const activationItem: ActivationItem = {
            itemId: item.itemId,
            sourceId: item.sourceId,
            sourceNativeId: item.sourceNativeId,
            eventVariant: item.eventVariant,
            inboxId: item.inboxId,
            occurredAt: item.occurredAt,
            metadata: item.metadata,
            rawPayload: item.rawPayload,
            deliveryHandle: item.deliveryHandle,
          };
          for (const target of targets) {
            this.enqueueActivationTarget(target, {
              agentId: subscription.agentId,
              subscriptionId: subscription.subscriptionId,
              sourceId: source.sourceId,
              summary: summarizeSourceEvent(source.sourceType, source.sourceKey, event.eventVariant),
              item: activationItem,
            });
          }
        }
      } catch (error) {
        if (insertedItems.length > 0) {
          this.notifyInboxWatchers(subscription.agentId, insertedItems);
        }
        if (lastProcessedOffset != null) {
          await this.backend.commit({
            consumerId: consumer.consumerId,
            committedOffset: lastProcessedOffset,
          });
        }
        throw error;
      }

      if (insertedItems.length > 0) {
        this.notifyInboxWatchers(subscription.agentId, insertedItems);
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
      retention: {
        ackedInboxItemsMs: this.ackedRetentionMs,
        gcIntervalMs: DEFAULT_GC_INTERVAL_MS,
        lastAckedInboxGcAt: this.lastAckedInboxGcAt > 0 ? new Date(this.lastAckedInboxGcAt).toISOString() : null,
      },
      counts: this.store.getCounts(),
      agents: this.store.listAgents(),
      sources: this.store.listSources(),
      subscriptions: this.store.listSubscriptions(),
      inboxes: this.store.listInboxes(),
      activationTargets: this.store.listActivationTargets(),
      activationDispatchStates: this.store.listActivationDispatchStates(),
      streams: this.store.listStreams(),
      consumers: this.store.listConsumers(),
      adapters: this.adapters.status(),
      recentActivations: this.store.listActivations().slice(0, 10),
      recentDeliveries: this.store.listDeliveries().slice(0, 10),
      lifecycle: {
        offlineAgentTtlMs: DEFAULT_OFFLINE_AGENT_TTL_MS,
        gcIntervalMs: DEFAULT_GC_INTERVAL_MS,
        lastOfflineAgentGcAt: this.lastOfflineAgentGcAt > 0 ? new Date(this.lastOfflineAgentGcAt).toISOString() : null,
      },
    };
  }

  private ensureInboxForAgent(agentId: string): Inbox {
    const existing = this.store.getInboxByAgentId(agentId);
    if (existing) {
      return existing;
    }
    const inbox: Inbox = {
      inboxId: defaultInboxIdForAgent(agentId),
      ownerAgentId: agentId,
      createdAt: nowIso(),
    };
    this.store.insertInbox(inbox);
    return inbox;
  }

  private inboxCounts(agentId: string): Record<string, number> {
    const inbox = this.ensureInboxForAgent(agentId);
    const total = this.store.countInboxItems(inbox.inboxId, true);
    const unacked = this.store.countInboxItems(inbox.inboxId, false);
    return {
      total,
      unacked,
      acked: total - unacked,
    };
  }

  private async runAckedInboxGcIfDue(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastAckedInboxGcAt < DEFAULT_GC_INTERVAL_MS) {
      return;
    }
    this.lastAckedInboxGcAt = now;
    this.gcAckedInboxItems();
  }

  private async ensureStreamForSource(source: SubscriptionSource) {
    return this.backend.ensureStream({
      sourceId: source.sourceId,
      streamKey: streamKeyForSource(source.sourceType, source.sourceKey),
      backend: "sqlite",
    });
  }

  private notifyInboxWatchers(agentId: string, items: InboxItem[]): void {
    const watchers = this.inboxWatchers.get(agentId);
    if (!watchers || watchers.size === 0) {
      return;
    }
    for (const watcher of watchers) {
      watcher.onItems(items);
    }
  }

  private upsertTerminalActivationTarget(agentId: string, input: RegisterAgentInput, now: string): TerminalActivationTarget {
    const existing = findExistingTerminalActivationTarget(this.store, input);
    if (existing) {
      const target = this.store.updateTerminalActivationTargetHeartbeat(existing.targetId, {
        runtimeKind: input.runtimeKind ?? "unknown",
        runtimeSessionId: input.runtimeSessionId ?? null,
        tmuxPaneId: input.tmuxPaneId ?? null,
        tty: input.tty ?? null,
        termProgram: input.termProgram ?? null,
        itermSessionId: input.itermSessionId ?? null,
        updatedAt: now,
        lastSeenAt: now,
      });
      if (target.agentId !== agentId) {
        throw new Error(`terminal target ${target.targetId} is already bound to agent ${target.agentId}`);
      }
      this.markAgentActive(agentId);
      return target;
    }

    const target: TerminalActivationTarget = {
      targetId: generateId("tgt"),
      agentId,
      kind: "terminal",
      status: "active",
      offlineSince: null,
      consecutiveFailures: 0,
      lastDeliveredAt: null,
      lastError: null,
      mode: "agent_prompt",
      notifyLeaseMs: input.notifyLeaseMs ?? DEFAULT_NOTIFY_LEASE_MS,
      runtimeKind: input.runtimeKind ?? "unknown",
      runtimeSessionId: input.runtimeSessionId ?? null,
      backend: input.backend,
      tmuxPaneId: input.tmuxPaneId ?? null,
      tty: input.tty ?? null,
      termProgram: input.termProgram ?? null,
      itermSessionId: input.itermSessionId ?? null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.store.insertActivationTarget(target);
    this.markAgentActive(agentId);
    return target;
  }

  private enqueueActivationTarget(
    target: ActivationTarget,
    input: {
      agentId: string;
      subscriptionId: string;
      sourceId: string;
      summary: string;
      item: ActivationItem;
    },
  ): void {
    const key = notificationBufferKey(target.agentId, target.targetId);
    let buffer = this.notificationBuffers.get(key);
    if (!buffer) {
      buffer = {
        agentId: target.agentId,
        targetId: target.targetId,
        pending: [],
        timer: null,
        inFlight: false,
      };
      this.notificationBuffers.set(key, buffer);
    }

    buffer.pending.push({
      subscriptionId: input.subscriptionId,
      sourceId: input.sourceId,
      summary: input.summary,
      item: input.item,
    });

    if (!buffer.timer && !buffer.inFlight) {
      buffer.timer = setTimeout(() => {
        void this.flushNotificationBuffer(key);
      }, this.activationWindowMs);
    }

    if (buffer.pending.length >= this.activationMaxItems) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      void this.flushNotificationBuffer(key);
    }
  }

  private clearSubscriptionRuntimeState(subscription: Subscription): void {
    for (const [key, buffer] of this.notificationBuffers.entries()) {
      const retained = buffer.pending.filter((entry) => entry.subscriptionId !== subscription.subscriptionId);
      if (retained.length === buffer.pending.length) {
        continue;
      }
      buffer.pending = retained;
      if (buffer.pending.length === 0) {
        if (buffer.timer) {
          clearTimeout(buffer.timer);
          buffer.timer = null;
        }
        this.notificationBuffers.delete(key);
      }
    }

    const remainingSubscriptions = this.store.listSubscriptionsForAgent(subscription.agentId);
    const states = this.store.listActivationDispatchStatesForAgent(subscription.agentId);
    for (const state of states) {
      const directlyReferencesRemovedSubscription = state.pendingSubscriptionIds.includes(subscription.subscriptionId);
      if (!directlyReferencesRemovedSubscription && remainingSubscriptions.length > 0) {
        continue;
      }
      // Dispatch state is stored per target rather than per subscription.
      // Drop states that still directly reference the removed subscription.
      // If the agent has no subscriptions left, also clear any residual lease
      // state so future subscriptions do not inherit a stale notified window.
      this.store.deleteActivationDispatchState(state.agentId, state.targetId);
    }
  }

  private async flushAllPendingNotifications(): Promise<void> {
    const keys = Array.from(this.notificationBuffers.keys());
    for (const key of keys) {
      await this.flushNotificationBuffer(key);
    }
  }

  private async flushNotificationBuffer(key: string): Promise<void> {
    const buffer = this.notificationBuffers.get(key);
    if (!buffer || buffer.inFlight || buffer.pending.length === 0) {
      return;
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    buffer.inFlight = true;
    const entries = buffer.pending.splice(0, buffer.pending.length);
    try {
      const state = this.store.getActivationDispatchState(buffer.agentId, buffer.targetId);
      if (!state) {
        const dispatched = await this.dispatchActivationTarget({
          agentId: buffer.agentId,
          targetId: buffer.targetId,
          newItemCount: entries.length,
          summary: entries[0]?.summary ?? null,
          subscriptionIds: uniqueSorted(entries.map((entry) => entry.subscriptionId)),
          sourceIds: uniqueSorted(entries.map((entry) => entry.sourceId)),
          items: entries.map((entry) => entry.item),
        });
        if (dispatched === "retryable_failure") {
          this.upsertDirtyDispatchState(buffer.agentId, buffer.targetId, entries);
        }
      } else {
        this.store.upsertActivationDispatchState({
          agentId: buffer.agentId,
          targetId: buffer.targetId,
          status: "dirty",
          leaseExpiresAt: state.leaseExpiresAt,
          pendingNewItemCount: state.pendingNewItemCount + entries.length,
          pendingSummary: state.pendingSummary ?? entries[0]?.summary ?? null,
          pendingSubscriptionIds: uniqueSorted([...state.pendingSubscriptionIds, ...entries.map((entry) => entry.subscriptionId)]),
          pendingSourceIds: uniqueSorted([...state.pendingSourceIds, ...entries.map((entry) => entry.sourceId)]),
          updatedAt: nowIso(),
        });
      }

      const hasPendingDuringFlight = buffer.pending.length > 0;
      buffer.inFlight = false;
      if (hasPendingDuringFlight) {
        buffer.timer = setTimeout(() => {
          void this.flushNotificationBuffer(key);
        }, this.activationWindowMs);
        return;
      }
      this.notificationBuffers.delete(key);
    } catch (error) {
      buffer.pending.unshift(...entries);
      buffer.inFlight = false;
      if (!this.stopping && !buffer.timer) {
        buffer.timer = setTimeout(() => {
          void this.flushNotificationBuffer(key);
        }, this.activationWindowMs);
      }
      throw error;
    }
  }

  private async handleInboxAckEffects(agentId: string): Promise<void> {
    const states = this.store.listActivationDispatchStatesForAgent(agentId);
    for (const state of states) {
      await this.maybeDispatchActivationTarget(agentId, state.targetId, "ack");
    }
  }

  private async maybeDispatchActivationTarget(
    agentId: string,
    targetId: string,
    reason: "ack" | "lease",
  ): Promise<void> {
    const state = this.store.getActivationDispatchState(agentId, targetId);
    if (!state) {
      return;
    }

    const inbox = this.ensureInboxForAgent(agentId);
    const unacked = this.store.countInboxItems(inbox.inboxId, false);
    if (unacked === 0) {
      this.store.deleteActivationDispatchState(agentId, targetId);
      return;
    }

    if (reason === "ack" && state.status !== "dirty") {
      return;
    }

    const dispatched = await this.dispatchActivationTarget({
      agentId,
      targetId,
      newItemCount: state.pendingNewItemCount > 0 ? state.pendingNewItemCount : unacked,
      summary: state.pendingSummary,
      subscriptionIds: state.pendingSubscriptionIds,
      sourceIds: state.pendingSourceIds,
      items: this.store.listInboxItems(inbox.inboxId, { includeAcked: false }).map((item) => ({
        itemId: item.itemId,
        sourceId: item.sourceId,
        sourceNativeId: item.sourceNativeId,
        eventVariant: item.eventVariant,
        inboxId: item.inboxId,
        occurredAt: item.occurredAt,
        metadata: item.metadata,
        rawPayload: item.rawPayload,
        deliveryHandle: item.deliveryHandle,
      })),
    });

    if (dispatched === "offline") {
      this.store.deleteActivationDispatchState(agentId, targetId);
      return;
    }
    if (dispatched === "retryable_failure") {
      this.store.upsertActivationDispatchState({
        ...state,
        status: "dirty",
        leaseExpiresAt: new Date(Date.now() + DEFAULT_NOTIFY_RETRY_MS).toISOString(),
        updatedAt: nowIso(),
      });
    }
  }

  private async dispatchActivationTarget(input: {
    agentId: string;
    targetId: string;
    newItemCount: number;
    summary: string | null;
    subscriptionIds: string[];
    sourceIds: string[];
    items: ActivationItem[];
  }): Promise<ActivationDispatchOutcome> {
    const target = this.getActivationTarget(input.targetId);
    if (target.status === "offline") {
      return "offline";
    }
    const inbox = this.ensureInboxForAgent(input.agentId);
    const summary = summarizeActivation(inbox.inboxId, input.newItemCount, input.summary);
    try {
      if (target.kind === "terminal") {
        const prompt = renderAgentPrompt({
          inboxId: inbox.inboxId,
          newItemCount: input.newItemCount,
          summary: input.summary,
        });
        await this.terminalDispatcher.dispatch(target, prompt);
      } else {
        const activation: Activation = {
          kind: "agentinbox.activation",
          activationId: generateId("act"),
          agentId: input.agentId,
          inboxId: inbox.inboxId,
          targetId: target.targetId,
          targetKind: target.kind,
          subscriptionIds: input.subscriptionIds,
          sourceIds: input.sourceIds,
          newItemCount: input.newItemCount,
          summary,
          items: target.mode === "activation_with_items" && input.items.length > 0 ? input.items : undefined,
          createdAt: nowIso(),
          deliveredAt: null,
        };
        await this.activationDispatcher.dispatch(target.url, activation);
        this.store.insertActivation(activation);
      }

      this.markActivationTargetDelivered(target.targetId);
      this.markAgentActive(input.agentId);

      this.store.upsertActivationDispatchState({
        agentId: input.agentId,
        targetId: input.targetId,
        status: "notified",
        leaseExpiresAt: new Date(Date.now() + target.notifyLeaseMs).toISOString(),
        pendingNewItemCount: 0,
        pendingSummary: null,
        pendingSubscriptionIds: [],
        pendingSourceIds: [],
        updatedAt: nowIso(),
      });
      return "dispatched";
    } catch (error) {
      console.warn(`activation target dispatch failed for ${target.targetId}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      if (target.kind === "terminal") {
        const exists = await this.terminalDispatcher.probe(target);
        if (!exists) {
          this.markActivationTargetOffline(target.targetId, message);
          this.reconcileAgentStatus(target.agentId);
          return "offline";
        }
      }
      this.markActivationTargetDispatchFailure(target.targetId, message);
      return "retryable_failure";
    }
  }

  private upsertDirtyDispatchState(
    agentId: string,
    targetId: string,
    entries: Array<{ subscriptionId: string; sourceId: string; summary: string }>,
  ): void {
    this.store.upsertActivationDispatchState({
      agentId,
      targetId,
      status: "dirty",
      leaseExpiresAt: new Date(Date.now() + DEFAULT_NOTIFY_RETRY_MS).toISOString(),
      pendingNewItemCount: entries.length,
      pendingSummary: entries[0]?.summary ?? null,
      pendingSubscriptionIds: uniqueSorted(entries.map((entry) => entry.subscriptionId)),
      pendingSourceIds: uniqueSorted(entries.map((entry) => entry.sourceId)),
      updatedAt: nowIso(),
    });
  }

  private markActivationTargetDelivered(targetId: string): void {
    const now = nowIso();
    this.store.updateActivationTargetRuntime(targetId, {
      status: "active",
      offlineSince: null,
      consecutiveFailures: 0,
      lastDeliveredAt: now,
      lastError: null,
      updatedAt: now,
      lastSeenAt: now,
    });
  }

  private markActivationTargetDispatchFailure(targetId: string, message: string): void {
    const target = this.getActivationTarget(targetId);
    this.store.updateActivationTargetRuntime(targetId, {
      status: "active",
      offlineSince: null,
      consecutiveFailures: target.consecutiveFailures + 1,
      lastError: message,
      updatedAt: nowIso(),
    });
  }

  private markActivationTargetOffline(targetId: string, message: string): void {
    const now = nowIso();
    const target = this.getActivationTarget(targetId);
    this.store.updateActivationTargetRuntime(targetId, {
      status: "offline",
      offlineSince: target.offlineSince ?? now,
      consecutiveFailures: target.consecutiveFailures + 1,
      lastError: message,
      updatedAt: now,
    });
  }

  private markAgentActive(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (agent.status === "active" && !agent.offlineSince) {
      return;
    }
    const now = nowIso();
    this.store.updateAgent(agentId, {
      status: "active",
      offlineSince: null,
      runtimeKind: agent.runtimeKind,
      runtimeSessionId: agent.runtimeSessionId ?? null,
      updatedAt: now,
      lastSeenAt: now,
    });
  }

  private reconcileAgentStatus(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (this.store.countActiveActivationTargetsForAgent(agentId) > 0) {
      this.markAgentActive(agentId);
      return;
    }
    const now = nowIso();
    this.store.updateAgent(agentId, {
      status: "offline",
      offlineSince: agent.offlineSince ?? now,
      runtimeKind: agent.runtimeKind,
      runtimeSessionId: agent.runtimeSessionId ?? null,
      updatedAt: now,
      lastSeenAt: agent.lastSeenAt,
    });
  }

  private gcOfflineAgents(now = Date.now()): { removedAgents: number } {
    const cutoffIso = new Date(now - DEFAULT_OFFLINE_AGENT_TTL_MS).toISOString();
    const agents = this.store.listOfflineAgentsOlderThan(cutoffIso);
    for (const agent of agents) {
      this.store.deleteAgent(agent.agentId, { persist: false });
      this.notificationBuffers.forEach((buffer, key) => {
        if (key.startsWith(`${agent.agentId}:`)) {
          if (buffer.timer) {
            clearTimeout(buffer.timer);
          }
          this.notificationBuffers.delete(key);
        }
      });
      this.inboxWatchers.delete(agent.agentId);
    }
    if (agents.length > 0) {
      this.store.save();
    }
    return { removedAgents: agents.length };
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

  private async syncActivationDispatchStates(): Promise<void> {
    const now = Date.now();
    const states = this.store.listActivationDispatchStates();
    for (const state of states) {
      if (!state.leaseExpiresAt) {
        continue;
      }
      const expiresAt = Date.parse(state.leaseExpiresAt);
      if (Number.isNaN(expiresAt) || expiresAt > now) {
        continue;
      }
      try {
        await this.maybeDispatchActivationTarget(state.agentId, state.targetId, "lease");
      } catch (error) {
        console.warn(`activation target lease sync failed for ${state.targetId}/${state.agentId}:`, error);
      }
    }
  }

  private async syncLifecycleGc(): Promise<void> {
    const now = Date.now();
    if (now - this.lastOfflineAgentGcAt < DEFAULT_GC_INTERVAL_MS) {
      return;
    }
    this.lastOfflineAgentGcAt = now;
    try {
      this.gcOfflineAgents(now);
    } catch (error) {
      console.warn("offline agent gc failed:", error);
    }
  }
}

function retentionCutoffIso(retentionMs: number): string {
  return new Date(Date.now() - retentionMs).toISOString();
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
  async dispatch(targetUrl: string, activation: Activation): Promise<void> {
    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activation),
      });
      if (!response.ok) {
        throw new Error(`activation dispatch failed for ${targetUrl}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`activation dispatch error for ${targetUrl}:`, error);
      throw error;
    }
  }
}

function validateTerminalRegistration(input: RegisterAgentInput): void {
  if (input.backend === "tmux") {
    if (!input.tmuxPaneId) {
      throw new Error("tmux agent registration requires tmuxPaneId");
    }
    return;
  }
  if (input.backend === "iterm2") {
    if (!input.itermSessionId && !input.tty) {
      throw new Error("iterm2 agent registration requires itermSessionId or tty");
    }
    return;
  }
  throw new Error(`unsupported terminal backend: ${String(input.backend)}`);
}

function validateNotifyLeaseMs(value: number | null | undefined): void {
  if (value == null) {
    return;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("notifyLeaseMs must be a positive integer");
  }
}

function normalizeWebhookActivationMode(mode: AddWebhookActivationTargetInput["activationMode"]): WebhookActivationTarget["mode"] {
  const resolved = mode ?? "activation_only";
  if (!WEBHOOK_ACTIVATION_MODES.has(resolved)) {
    throw new Error(`unsupported activation mode: ${String(mode)}`);
  }
  return resolved;
}

function findExistingTerminalActivationTarget(store: AgentInboxStore, input: RegisterAgentInput): TerminalActivationTarget | null {
  if (input.runtimeSessionId) {
    const target = store.getTerminalActivationTargetByRuntimeSession(input.runtimeKind ?? "unknown", input.runtimeSessionId);
    if (target) {
      return target;
    }
  }
  if (input.backend === "tmux" && input.tmuxPaneId) {
    return store.getTerminalActivationTargetByTmuxPaneId(input.tmuxPaneId);
  }
  if (input.backend === "iterm2") {
    if (input.itermSessionId) {
      return store.getTerminalActivationTargetByItermSessionId(input.itermSessionId);
    }
    if (input.tty) {
      return store.getTerminalActivationTargetByTty(input.tty);
    }
  }
  return null;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function notificationBufferKey(agentId: string, targetId: string): string {
  return `${agentId}::${targetId}`;
}

function summarizeActivation(inboxId: string, newItemCount: number, firstSummary: string | null): string {
  const itemWord = newItemCount === 1 ? "item" : "items";
  if (firstSummary) {
    return `${newItemCount} new ${itemWord} in ${inboxId} from ${firstSummary}`;
  }
  return `${newItemCount} new ${itemWord} in ${inboxId}`;
}

function summarizeSourceEvent(sourceType: string, sourceKey: string, eventVariant: string): string {
  if (sourceType === "github_repo_ci") {
    const parts = eventVariant.split(".");
    const [, second, third, fourth] = parts;
    const knownStatuses = new Set(["completed", "in_progress", "queued", "requested", "waiting", "pending", "observed"]);
    const workflowName = second && !knownStatuses.has(second) ? second : null;
    const status = workflowName ? third : second;
    const conclusion = workflowName ? fourth : third;
    const summaryParts = [`${sourceType}:${sourceKey}`];
    if (workflowName) {
      summaryParts.push(workflowName);
    }
    if (status) {
      summaryParts.push(status);
    }
    if (conclusion) {
      summaryParts.push(conclusion);
    }
    return summaryParts.join(":");
  }
  return `${sourceType}:${sourceKey}:${eventVariant}`;
}
