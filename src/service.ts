import {
  Activation,
  ActivationDispatchDeferReason,
  ActivationItem,
  ActivationTarget,
  AddWebhookActivationTargetInput,
  Agent,
  AgentTimer,
  DirectInboxTextMessageInput,
  DirectInboxTextMessageResult,
  AppendSourceEventInput,
  AppendSourceEventResult,
  DeliveryAttempt,
  DeliveryActionsRequest,
  DeliveryHandle,
  DeliveryInvokeRequest,
  DeliveryOperationDescriptor,
  DeliveryRequest,
  Inbox,
  InboxAggregationPolicy,
  InboxEntry,
  InboxItem,
  InboxWatchEvent,
  NotificationGrouping,
  NotificationPolicy,
  PreviewSourceSchemaInput,
  RegisterAgentInput,
  RegisterAgentResult,
  RegisterHostInput,
  RegisterSourceInput,
  RegisterSubscriptionInput,
  RegisterTimerInput,
  ResolvedSourceIdentity,
  ResolvedSourceSchema,
  SourceHost,
  SourceSchema,
  SourceSchemaPreview,
  SourcePollResult,
  SourceStream,
  Subscription,
  CleanupPolicy,
  SubscriptionLifecycleRetirement,
  SubscriptionPollResult,
  TerminalActivationTarget,
  UpdateTimerStatusResult,
  UpdateSourceInput,
  WatchInboxOptions,
  WebhookActivationTarget,
} from "./model";
import { createHash } from "node:crypto";
import { AgentInboxStore } from "./store";
import { AdapterRegistry } from "./adapters";
import {
  ConsumerLag,
  EventBusBackend,
  SqliteEventBusBackend,
  streamKeyForSource,
  toAppendResult,
} from "./backend";
import { formatEntryRef, generateCanonicalId, nowIso } from "./util";
import { getSourceSchema } from "./source_schema";
import { withResolvedIdentity } from "./source_resolution";
import { matchSubscriptionFilter, validateSubscriptionFilter } from "./filter";
import {
  assignedAgentIdFromContext,
  deriveInlineItemPreview,
  detectTerminalContext,
  normalizeInlinePreviewText,
  renderAgentPrompt,
  TerminalDispatcher,
} from "./terminal";
import { ExpandedSubscriptionMember, ExpandedSubscriptionPlan, LifecycleSignal } from "./sources/remote_modules";
import { ActivationGate, DefaultActivationGate, GatingPolicy } from "./runtime_gate";
import { Logger, NoopLogger } from "./logging";
import { resolveSourceRegistration } from "./source_hosts";

const DEFAULT_SUBSCRIPTION_POLL_LIMIT = 100;
const DEFAULT_ACTIVATION_WINDOW_MS = 3_000;
const DEFAULT_ACTIVATION_MAX_ITEMS = 20;
const DEFAULT_NOTIFY_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_NOTIFY_RETRY_MS = 5_000;
const MAX_TERMINAL_DEFER_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_ACKED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_AGENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GC_INTERVAL_MS = 60 * 1000;
const DEFAULT_SYNC_INTERVAL_MS = 2_000;
const DEFAULT_IDLE_SOURCE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_INBOX_AGGREGATION_WINDOW_MS = 30 * 1000;
const DEFAULT_INBOX_AGGREGATION_MAX_ITEMS = 20;
const DEFAULT_INBOX_AGGREGATION_MAX_THREAD_AGE_MS = 24 * 60 * 60 * 1000;
const DIRECT_INBOX_SOURCE_ID = "__agentinbox_direct_text__";
const DIRECT_INBOX_EVENT_VARIANT = "agentinbox.direct_text_message";
const TIMER_INBOX_SOURCE_ID = "__agentinbox_timer__";
const TIMER_INBOX_EVENT_VARIANT = "agentinbox.timer_fired";
const DEFAULT_TIMER_SENDER = "timer";
const MIN_TIMER_INTERVAL_MS = 60 * 1000;
const WEBHOOK_ACTIVATION_MODES = new Set<WebhookActivationTarget["mode"]>(["activation_only", "activation_with_items"]);
const SUBSCRIPTION_START_POLICIES = new Set<Subscription["startPolicy"]>(["latest", "earliest", "at_offset", "at_time"]);
interface ActivationPolicy {
  windowMs?: number;
  maxItems?: number;
}

interface BufferedNotification {
  agentId: string;
  targetId: string;
  pending: Array<{
    subscriptionId: string | null;
    sourceId: string;
    summary: string;
    entry: InboxEntry;
  }>;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
}

interface InboxWatcher {
  onItems(entries: InboxEntry[]): void;
}

type ActivationDispatchOutcome = "dispatched" | "retryable_failure" | "offline" | "deferred" | "suppressed";

export interface InboxWatchSession {
  initialItems: InboxEntry[];
  start(): void;
  close(): void;
}

type ResumeTargetReason =
  | "already_active"
  | "terminal_available"
  | "terminal_busy"
  | "terminal_gone"
  | "probe_unknown"
  | "webhook_resumed";

export interface ResumeActivationTargetResult {
  targetId: string;
  resumed: boolean;
  status: ActivationTarget["status"];
  reason: ResumeTargetReason;
}

export interface ResumeAgentResult {
  resumed: boolean;
  agent: Agent;
  targets: ResumeActivationTargetResult[];
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
  private timerSyncTimeout: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastAckedInboxGcAt = 0;
  private lastLifecycleCleanupAt = 0;
  private lastOfflineAgentGcAt = 0;

  constructor(
    private readonly store: AgentInboxStore,
    private readonly adapters: AdapterRegistry,
    activationDispatcher: ActivationDispatcher = new ActivationDispatcher(),
    backend?: EventBusBackend,
    activationPolicy?: ActivationPolicy,
    terminalDispatcher: TerminalDispatcher = new TerminalDispatcher(),
    activationGate?: ActivationGate,
    logger: Logger = new NoopLogger(),
    gatingPolicy?: GatingPolicy,
  ) {
    this.activationDispatcher = activationDispatcher;
    this.backend = backend ?? new SqliteEventBusBackend(store);
    this.activationWindowMs = activationPolicy?.windowMs ?? DEFAULT_ACTIVATION_WINDOW_MS;
    this.activationMaxItems = activationPolicy?.maxItems ?? DEFAULT_ACTIVATION_MAX_ITEMS;
    this.ackedRetentionMs = DEFAULT_ACKED_RETENTION_MS;
    this.terminalDispatcher = terminalDispatcher;
    this.logger = logger;
    this.activationGate = activationGate ?? new DefaultActivationGate(undefined, undefined, this.logger.child("gate"), gatingPolicy);
  }

  private readonly activationDispatcher: ActivationDispatcher;
  private readonly terminalDispatcher: TerminalDispatcher;
  private readonly activationGate: ActivationGate;
  private readonly logger: Logger;

  async start(): Promise<void> {
    if (this.syncInterval) {
      return;
    }
    this.stopping = false;
    this.syncInterval = setInterval(() => {
      void this.syncAllSubscriptions();
      void this.syncPendingDigestThreads();
      void this.syncActivationDispatchStates();
      void this.runAckedInboxGcIfDue();
      void this.syncLifecycleGc();
    }, DEFAULT_SYNC_INTERVAL_MS);
    this.refreshTimersOnStart();
    await this.syncAllSubscriptions();
    await this.syncPendingDigestThreads();
    await this.syncActivationDispatchStates();
    await this.runAckedInboxGcIfDue(true);
    await this.syncLifecycleGc();
    await this.syncTimers();
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
    if (this.timerSyncTimeout) {
      clearTimeout(this.timerSyncTimeout);
      this.timerSyncTimeout = null;
    }
    await this.flushAllPendingNotifications();
    await this.awaitInFlightNotificationBuffers();
  }

  async registerSource(input: RegisterSourceInput): Promise<SourceStream> {
    const existing = this.store.getSourceByKey(input.sourceType, input.sourceKey);
    if (existing) {
      return existing;
    }
    const resolved = resolveSourceRegistration(input);
    const now = nowIso();
    let host = this.store.getSourceHostByKey(resolved.hostType, resolved.hostKey);
    if (!host) {
      host = {
        hostId: generateCanonicalId("hst"),
        hostType: resolved.hostType,
        hostKey: resolved.hostKey,
        configRef: input.configRef ?? null,
        config: resolved.hostConfig,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      this.store.insertSourceHost(host);
    }
    const source: SourceStream = {
      sourceId: generateCanonicalId("src"),
      hostId: host.hostId,
      streamKind: resolved.streamKind,
      streamKey: resolved.streamKey,
      sourceType: resolved.sourceType,
      sourceKey: input.sourceKey,
      configRef: input.configRef ?? null,
      config: resolved.streamConfig,
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

  listSources(): SourceStream[] {
    return this.store.listSources();
  }

  listHosts(): SourceHost[] {
    return this.store.listSourceHosts();
  }

  getHost(hostId: string): SourceHost {
    const host = this.store.getSourceHost(hostId);
    if (!host) {
      throw new Error(`unknown host: ${hostId}`);
    }
    return host;
  }

  getHostDetails(hostId: string): Record<string, unknown> {
    const host = this.getHost(hostId);
    const streams = this.store.listSources().filter((stream) => stream.hostId === hostId);
    return {
      host,
      schema: this.getHostSchema(host.hostType),
      streams,
    };
  }

  getSource(sourceId: string): SourceStream {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`unknown source: ${sourceId}`);
    }
    return source;
  }

  async getSourceDetails(sourceId: string): Promise<Record<string, unknown>> {
    const source = this.getSource(sourceId);
    const fallbackSchema = getSourceSchema(source.sourceType);
    let resolvedIdentity: ResolvedSourceIdentity | null = null;
    let resolutionError: string | null = null;
    let schema: SourceSchema | ResolvedSourceSchema = fallbackSchema;
    try {
      resolvedIdentity = await this.adapters.resolveSourceIdentity(source);
      schema = await this.adapters.resolveSourceSchema(source);
    } catch (error) {
      resolutionError = error instanceof Error ? error.message : String(error);
    }
    const resolvedSchema = resolvedIdentity
      ? ("hostType" in schema
        ? schema
        : withResolvedIdentity(source.sourceId, fallbackSchema, resolvedIdentity))
      : fallbackSchema;
    return {
      source,
      host: source.hostId ? this.store.getSourceHost(source.hostId) : null,
      resolvedIdentity,
      ...(resolutionError ? { resolutionError } : {}),
      schema: resolvedSchema,
      stream: this.store.getStreamBySourceId(sourceId),
      subscriptions: this.store.listSubscriptionsForSource(sourceId),
      idleState: this.store.getSourceIdleState(sourceId),
    };
  }

  getSourceSchema(sourceType: SourceStream["sourceType"]): SourceSchema {
    return getSourceSchema(sourceType);
  }

  getHostSchema(hostType: SourceHost["hostType"]): Record<string, unknown> {
    return {
      hostType,
      configFields: getHostConfigFields(hostType),
      streamKinds: listHostStreamKinds(hostType),
    };
  }

  registerHost(input: RegisterHostInput): SourceHost {
    const existing = this.store.getSourceHostByKey(input.hostType, input.hostKey);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    const host: SourceHost = {
      hostId: generateCanonicalId("hst"),
      hostType: input.hostType,
      hostKey: input.hostKey,
      configRef: input.configRef ?? null,
      config: input.config ?? {},
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSourceHost(host);
    return host;
  }

  registerStream(input: {
    hostId: string;
    streamKind: string;
    streamKey: string;
    configRef?: string | null;
    config?: Record<string, unknown>;
  }): Promise<SourceStream> {
    const host = this.getHost(input.hostId);
    const existing = this.store.listSources().find((stream) =>
      stream.hostId === input.hostId &&
      stream.streamKind === input.streamKind &&
      stream.streamKey === input.streamKey,
    );
    if (existing) {
      return Promise.resolve(existing);
    }
    const sourceType = sourceTypeForStreamRegistration(host.hostType, input.streamKind);
    const now = nowIso();
    const stream: SourceStream = {
      sourceId: generateCanonicalId("src"),
      streamId: null,
      hostId: input.hostId,
      streamKind: input.streamKind,
      streamKey: input.streamKey,
      sourceType,
      sourceKey: input.streamKey,
      configRef: input.configRef ?? host.configRef ?? null,
      config: input.config ?? {},
      status: "active",
      checkpoint: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSource(stream);
    return this.adapters.sourceAdapterFor(sourceType)
      .ensureSource(stream)
      .then(async () => {
        await this.ensureStreamForSource(stream);
        return this.getStream(stream.sourceId);
      });
  }

  listStreams(): SourceStream[] {
    return this.listSources();
  }

  getStream(streamId: string): SourceStream {
    return this.getSource(streamId);
  }

  getStreamDetails(streamId: string): Promise<Record<string, unknown>> {
    return this.getSourceDetails(streamId);
  }

  async getResolvedSourceSchema(sourceId: string): Promise<ResolvedSourceSchema> {
    const source = this.getSource(sourceId);
    return this.adapters.resolveSourceSchema(source);
  }

  async previewSourceSchema(input: PreviewSourceSchemaInput): Promise<SourceSchemaPreview> {
    try {
      const source = buildPreviewSource(input);
      await this.adapters.sourceAdapterFor(source.sourceType).validateSource?.(source);
      const schema = await this.adapters.resolveSourceSchema(source);
      if (input.sourceRef.startsWith("remote:")) {
        const expectedImplementationId = input.sourceRef.slice("remote:".length);
        if (schema.implementationId !== expectedImplementationId) {
          throw new Error(
            `preview source kind ${input.sourceRef} resolved to implementation ${schema.implementationId}`,
          );
        }
      }
      const { sourceId: _sourceId, ...preview } = schema;
      return preview;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("preview failed: ") || message.startsWith("preview source kind ")) {
        throw error;
      }
      throw new Error(`preview failed: ${message}`);
    }
  }

  async removeSource(
    sourceId: string,
    options: { withSubscriptions?: boolean } = {},
  ): Promise<{ removed: boolean; sourceId: string; removedSubscriptions: number; pausedSource: boolean }> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      return { removed: false, sourceId, removedSubscriptions: 0, pausedSource: false };
    }
    const subscriptions = this.store.listSubscriptionsForSource(sourceId);
    if (subscriptions.length > 0 && !options.withSubscriptions) {
      throw new Error(
        "source remove requires no active subscriptions; retry with --with-subscriptions or with_subscriptions=true",
      );
    }
    let pausedSource = false;
    if (options.withSubscriptions) {
      const sourceAdapter = this.adapters.sourceAdapterFor(source.sourceType);
      if (sourceAdapter.pauseSource) {
        await this.pauseSource(sourceId);
        pausedSource = true;
      }
      for (const subscription of subscriptions) {
        await this.removeSubscription(subscription.subscriptionId);
      }
    }
    await this.adapters.removeSource(source);
    this.store.deleteSource(sourceId);
    return {
      removed: true,
      sourceId,
      removedSubscriptions: subscriptions.length,
      pausedSource,
    };
  }

  async updateSource(sourceId: string, input: UpdateSourceInput): Promise<{ updated: boolean; source: SourceStream | null }> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      return { updated: false, source: null };
    }
    const hasConfigRef = Object.prototype.hasOwnProperty.call(input, "configRef");
    const hasConfig = Object.prototype.hasOwnProperty.call(input, "config");
    if (!hasConfigRef && !hasConfig) {
      throw new Error("source update requires configRef and/or config");
    }

    const previous = {
      configRef: source.configRef ?? null,
      config: source.config ?? {},
      status: source.status,
      checkpoint: source.checkpoint ?? null,
    };

    const updated = this.store.updateSourceDefinition(sourceId, {
      ...(hasConfigRef ? { configRef: input.configRef ?? null } : {}),
      ...(hasConfig ? { config: input.config ?? {} } : {}),
    });

    try {
      if (updated.status === "paused") {
        await this.adapters.sourceAdapterFor(updated.sourceType).validateSource?.(updated);
      } else {
        await this.adapters.sourceAdapterFor(updated.sourceType).ensureSource(updated);
      }
    } catch (error) {
      this.store.updateSourceDefinition(sourceId, {
        configRef: previous.configRef,
        config: previous.config,
      });
      this.store.updateSourceRuntime(sourceId, {
        status: previous.status,
        checkpoint: previous.checkpoint,
      });
      throw error;
    }

    return {
      updated: true,
      source: this.getSource(sourceId),
    };
  }

  async pauseSource(sourceId: string): Promise<{ paused: boolean; source: SourceStream | null }> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      return { paused: false, source: null };
    }
    await this.adapters.pauseSource(source);
    if (this.store.getSource(sourceId)?.status !== "paused") {
      this.store.updateSourceRuntime(sourceId, { status: "paused" });
    }
    this.store.deleteSourceIdleState(sourceId);
    return {
      paused: true,
      source: this.getSource(sourceId),
    };
  }

  async resumeSource(sourceId: string): Promise<{ resumed: boolean; source: SourceStream | null }> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      return { resumed: false, source: null };
    }
    await this.adapters.resumeSource(source);
    if (this.store.getSource(sourceId)?.status === "paused") {
      this.store.updateSourceRuntime(sourceId, { status: "active" });
    }
    this.store.deleteSourceIdleState(sourceId);
    return {
      resumed: true,
      source: this.getSource(sourceId),
    };
  }

  registerAgent(input: RegisterAgentInput): RegisterAgentResult {
    validateNotifyLeaseMs(input.notifyLeaseMs);
    validateMinUnackedItems(input.minUnackedItems);
    validateTerminalRegistration(input);

    const runtimeKind = input.runtimeKind ?? "unknown";
    const agentId = input.agentId ?? this.resolveAutoAgentId({
      runtimeKind,
      runtimeSessionId: input.runtimeSessionId ?? null,
      backend: input.backend,
      tmuxPaneId: input.tmuxPaneId ?? null,
      itermSessionId: input.itermSessionId ?? null,
      tty: input.tty ?? null,
    });
    const now = nowIso();
    this.handleAgentRegistrationConflicts(agentId, input);
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
      runtimePid: detected.runtimePid ?? null,
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
    const affectedSourceIds = Array.from(
      new Set(this.store.listSubscriptionsForAgent(agentId).map((subscription) => subscription.sourceId)),
    );
    this.store.deleteAgent(agentId);
    for (const sourceId of affectedSourceIds) {
      this.refreshSourceIdleState(sourceId);
    }
    this.notificationBuffers.forEach((buffer, key) => {
      if (key.startsWith(`${agentId}:`)) {
        if (buffer.timer) {
          clearTimeout(buffer.timer);
        }
        this.notificationBuffers.delete(key);
      }
    });
    this.inboxWatchers.delete(agentId);
    this.rescheduleTimerSync();
    return { removed: true };
  }

  registerTimer(input: RegisterTimerInput): AgentTimer {
    this.getAgent(input.agentId);
    const normalized = normalizeTimerInput(input);
    const timezone = normalized.timezone ?? detectHostTimezone();
    assertValidTimeZone(timezone);
    const now = nowIso();
    const nextFireAt = computeNextTimerFire({
      mode: normalized.mode,
      at: normalized.at ?? null,
      intervalMs: normalized.every ?? null,
      cronExpr: normalized.cron ?? null,
      timezone,
      fromIso: now,
      lastFiredAt: null,
      restartRecovery: false,
    });
    const timer: AgentTimer = {
      scheduleId: generateCanonicalId("sch"),
      agentId: input.agentId,
      status: nextFireAt ? "active" : "paused",
      mode: normalized.mode,
      at: normalized.at ?? null,
      intervalMs: normalized.every ?? null,
      cronExpr: normalized.cron ?? null,
      timezone,
      message: normalizeDirectInboxMessage(input.message),
      sender: normalizeDirectInboxSender(input.sender) ?? DEFAULT_TIMER_SENDER,
      nextFireAt,
      lastFiredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertTimer(timer);
    this.rescheduleTimerSync();
    return timer;
  }

  listTimers(agentId?: string): AgentTimer[] {
    if (agentId) {
      this.getAgent(agentId);
      return this.store.listTimersForAgent(agentId);
    }
    return this.store.listTimers();
  }

  getTimer(scheduleId: string): AgentTimer {
    const timer = this.store.getTimer(scheduleId);
    if (!timer) {
      throw new Error(`unknown timer: ${scheduleId}`);
    }
    return timer;
  }

  pauseTimer(scheduleId: string): UpdateTimerStatusResult {
    const timer = this.getTimer(scheduleId);
    const updated = this.store.updateTimer(scheduleId, {
      status: "paused",
      nextFireAt: null,
      updatedAt: nowIso(),
    });
    this.rescheduleTimerSync();
    return {
      updated: timer.status !== "paused",
      timer: updated,
    };
  }

  resumeTimer(scheduleId: string): UpdateTimerStatusResult {
    const timer = this.getTimer(scheduleId);
    if (timer.mode === "at" && timer.lastFiredAt) {
      throw new Error(`timer ${scheduleId} already fired`);
    }
    const now = nowIso();
    const nextFireAt = computeNextTimerFire({
      mode: timer.mode,
      at: timer.at ?? null,
      intervalMs: timer.intervalMs ?? null,
      cronExpr: timer.cronExpr ?? null,
      timezone: timer.timezone,
      fromIso: now,
      lastFiredAt: timer.lastFiredAt ?? null,
      restartRecovery: false,
    });
    const status: AgentTimer["status"] = nextFireAt ? "active" : "paused";
    const updated = this.store.updateTimer(scheduleId, {
      status,
      nextFireAt,
      updatedAt: now,
    });
    this.rescheduleTimerSync();
    return {
      updated: timer.status !== status,
      timer: updated,
    };
  }

  removeTimer(scheduleId: string): { removed: boolean; scheduleId: string } {
    this.getTimer(scheduleId);
    this.store.deleteTimer(scheduleId);
    this.rescheduleTimerSync();
    return { removed: true, scheduleId };
  }

  addWebhookActivationTarget(agentId: string, input: AddWebhookActivationTargetInput): WebhookActivationTarget {
    this.getAgent(agentId);
    validateNotifyLeaseMs(input.notifyLeaseMs);
    validateMinUnackedItems(input.minUnackedItems);
    const mode = normalizeWebhookActivationMode(input.activationMode);
    const now = nowIso();
    const target: WebhookActivationTarget = {
      targetId: generateCanonicalId("tgt"),
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
      minUnackedItems: input.minUnackedItems ?? null,
      notificationPolicy: {
        notifyLeaseMs: input.notifyLeaseMs ?? DEFAULT_NOTIFY_LEASE_MS,
        minUnackedItems: input.minUnackedItems ?? null,
      },
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

  async resumeAgent(agentId: string): Promise<ResumeAgentResult> {
    this.getAgent(agentId);
    const targets = this.store.listActivationTargetsForAgent(agentId);
    const results: ResumeActivationTargetResult[] = [];
    for (const target of targets) {
      results.push(await this.resumeActivationTarget(agentId, target.targetId));
    }
    this.reconcileAgentStatus(agentId);
    return {
      resumed: results.some((result) => result.resumed),
      agent: this.getAgent(agentId),
      targets: results,
    };
  }

  async resumeActivationTarget(agentId: string, targetId: string): Promise<ResumeActivationTargetResult> {
    const target = this.getActivationTarget(targetId);
    if (target.agentId !== agentId) {
      throw new Error(`activation target ${targetId} does not belong to agent ${agentId}`);
    }
    if (target.status === "active") {
      return {
        targetId: target.targetId,
        resumed: false,
        status: target.status,
        reason: "already_active",
      };
    }

    let result: ResumeActivationTargetResult;
    if (target.kind === "terminal") {
      result = await this.resumeTerminalActivationTarget(target);
    } else {
      const now = nowIso();
      this.store.updateActivationTargetRuntime(target.targetId, {
        status: "active",
        offlineSince: null,
        consecutiveFailures: 0,
        lastError: null,
        updatedAt: now,
        lastSeenAt: now,
      });
      result = {
        targetId: target.targetId,
        resumed: true,
        status: "active",
        reason: "webhook_resumed",
      };
    }
    this.reconcileAgentStatus(agentId);
    return result;
  }

  async registerSubscription(input: RegisterSubscriptionInput): Promise<Subscription> {
    const subscriptions = await this.registerSubscriptions(input);
    return subscriptions[0]!;
  }

  async registerSubscriptions(input: RegisterSubscriptionInput): Promise<Subscription[]> {
    if (input.shortcut) {
      const source = this.store.getSource(input.sourceId);
      if (!source) {
        throw new Error(`unknown source: ${input.sourceId}`);
      }
      if (hasSubscriptionFieldOverride(input)) {
        throw new Error("subscription add shortcut does not allow filter, trackedResourceRef, or cleanupPolicy overrides");
      }
      const expanded = await this.adapters.expandSubscriptionShortcut(source, input.shortcut);
      if (!expanded) {
        throw new Error(`unknown subscription shortcut ${input.shortcut.name} for source ${input.sourceId}`);
      }
      return this.registerExpandedShortcutSubscriptions(input, source, expanded);
    }
    return [await this.registerSingleSubscription(input)];
  }

  private async registerExpandedShortcutSubscriptions(
    input: RegisterSubscriptionInput,
    source: SourceStream,
    plan: ExpandedSubscriptionPlan,
  ): Promise<Subscription[]> {
    if (plan.members.length === 0) {
      throw new Error(`subscription shortcut ${input.shortcut?.name ?? "unknown"} did not produce any subscriptions`);
    }
    const resolvedMembers = plan.members.map((member) => ({
      source: this.resolveShortcutMemberSource(source, member),
      member,
    }));
    const created: Subscription[] = [];
    for (const { source: memberSource, member } of resolvedMembers) {
      created.push(await this.registerSingleSubscription({
        ...input,
        sourceId: memberSource.sourceId,
        shortcut: undefined,
        filter: member.filter,
        trackedResourceRef: member.trackedResourceRef ?? null,
        cleanupPolicy: member.cleanupPolicy ?? null,
      }));
    }
    return created;
  }

  private resolveShortcutMemberSource(source: SourceStream, member: ExpandedSubscriptionMember): SourceStream {
    if (!member.streamKind || member.streamKind === source.streamKind) {
      return source;
    }
    if (!source.hostId || !source.streamKey) {
      throw new Error(`subscription shortcut ${source.sourceId} requires a host-scoped source to resolve ${member.streamKind}`);
    }
    const sibling = this.store.listSources().find((candidate) =>
      candidate.hostId === source.hostId &&
      candidate.streamKind === member.streamKind &&
      candidate.streamKey === source.streamKey,
    );
    if (!sibling) {
      throw new Error(
        `subscription shortcut ${source.sourceId} requires an existing sibling ${member.streamKind} stream under host ${source.hostId} with streamKey ${source.streamKey}`,
      );
    }
    return sibling;
  }

  private async registerSingleSubscription(input: RegisterSubscriptionInput): Promise<Subscription> {
    this.getAgent(input.agentId);
    const source = this.store.getSource(input.sourceId);
    if (!source) {
      throw new Error(`unknown source: ${input.sourceId}`);
    }
    await validateSubscriptionFilter(input.filter ?? {});
    const cleanupPolicy = normalizeCleanupPolicy(input.cleanupPolicy ?? null);
    const idleState = this.store.getSourceIdleState(source.sourceId);
    if (idleState?.autoPausedAt) {
      await this.resumeSource(source.sourceId);
    } else if (idleState) {
      this.store.deleteSourceIdleState(source.sourceId);
    }
    const subscription: Subscription = {
      subscriptionId: generateCanonicalId("sub"),
      agentId: input.agentId,
      sourceId: input.sourceId,
      filter: input.filter ?? {},
      trackedResourceRef: normalizeTrackedResourceRef(input.trackedResourceRef),
      cleanupPolicy,
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
    this.store.deleteSourceIdleState(source.sourceId);
    return subscription;
  }

  async removeSubscription(subscriptionId: string): Promise<{ removed: boolean; subscriptionId: string }> {
    const subscription = this.getSubscription(subscriptionId);
    await this.backend.deleteConsumer({ subscriptionId });
    this.store.deleteSubscription(subscriptionId);
    this.clearSubscriptionRuntimeState(subscription);
    this.refreshSourceIdleState(subscription.sourceId);
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
    if (source.sourceType !== "local_event") {
      throw new Error(`manual append is not supported for source type: ${source.sourceType}`);
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

  listInboxItems(agentId: string, options?: WatchInboxOptions): InboxEntry[] {
    return this.store.listInboxEntries(this.ensureInboxForAgent(agentId).inboxId, options);
  }

  listRawInboxItems(agentId: string, options?: WatchInboxOptions): InboxItem[] {
    return this.store.listInboxItems(this.ensureInboxForAgent(agentId).inboxId, options);
  }

  getInboxAggregationPolicy(agentId: string): InboxAggregationPolicy {
    const inbox = this.ensureInboxForAgent(agentId);
    return inboxAggregationPolicy(inbox);
  }

  updateInboxAggregationPolicy(agentId: string, input: InboxAggregationPolicy): InboxAggregationPolicy {
    const inbox = this.ensureInboxForAgent(agentId);
    const updated = this.store.updateInboxAggregationPolicy(inbox.inboxId, {
      enabled: input.enabled,
      windowMs: input.windowMs,
      maxItems: input.maxItems,
      maxThreadAgeMs: input.maxThreadAgeMs,
    });
    return inboxAggregationPolicy(updated);
  }

  async addDirectInboxTextMessage(
    agentId: string,
    input: DirectInboxTextMessageInput,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<DirectInboxTextMessageResult> {
    this.getAgent(agentId);
    const message = normalizeDirectInboxMessage(input.message);
    const sender = normalizeDirectInboxSender(input.sender) ?? this.detectDirectInboxSender(env);
    return this.materializeAgentInboxItem(agentId, {
      sourceId: DIRECT_INBOX_SOURCE_ID,
      sourceNativeId: generateCanonicalId("direct"),
      eventVariant: DIRECT_INBOX_EVENT_VARIANT,
      summary: summarizeDirectInboxMessage(sender),
      rawPayload: {
        type: "direct_text_message",
        message,
        sender,
      },
    });
  }

  private async fireTimer(timer: AgentTimer, now: string): Promise<void> {
    const scheduledFireAt = timer.nextFireAt ?? now;
    this.materializeAgentInboxItem(timer.agentId, {
      sourceId: TIMER_INBOX_SOURCE_ID,
      sourceNativeId: `${timer.scheduleId}:${scheduledFireAt}`,
      eventVariant: TIMER_INBOX_EVENT_VARIANT,
      summary: summarizeTimerMessage(timer.scheduleId),
      rawPayload: {
        type: "timer_fired",
        scheduleId: timer.scheduleId,
        message: timer.message,
        sender: timer.sender ?? DEFAULT_TIMER_SENDER,
      },
      occurredAt: scheduledFireAt,
      allowDuplicate: true,
    });

    const nextFireAt = computeNextTimerFire({
      mode: timer.mode,
      at: timer.at ?? null,
      intervalMs: timer.intervalMs ?? null,
      cronExpr: timer.cronExpr ?? null,
      timezone: timer.timezone,
      fromIso: scheduledFireAt,
      lastFiredAt: scheduledFireAt,
      restartRecovery: false,
    });
    this.store.updateTimer(timer.scheduleId, {
      status: nextFireAt ? "active" : "paused",
      nextFireAt,
      lastFiredAt: now,
      updatedAt: now,
    });
  }

  private materializeAgentInboxItem(
    agentId: string,
    input: {
      sourceId: string;
      sourceNativeId: string;
      eventVariant: string;
      summary: string;
      rawPayload: Record<string, unknown>;
      occurredAt?: string;
      allowDuplicate?: boolean;
    },
  ): DirectInboxTextMessageResult {
    const inbox = this.ensureInboxForAgent(agentId);
    const occurredAt = input.occurredAt ?? nowIso();
    const item: InboxItem = {
      itemId: generateCanonicalId("itm"),
      sourceId: input.sourceId,
      sourceNativeId: input.sourceNativeId,
      eventVariant: input.eventVariant,
      inboxId: inbox.inboxId,
      occurredAt,
      metadata: {},
      rawPayload: input.rawPayload,
      deliveryHandle: null,
      ackedAt: null,
    };
    const inserted = this.store.insertInboxItem(item);
    if (!inserted && !input.allowDuplicate) {
      throw new Error(`failed to persist direct inbox message item: ${item.itemId}`);
    }
    if (!inserted) {
      return {
        itemId: item.itemId,
        inboxId: inbox.inboxId,
        activated: false,
      };
    }
    const entry = this.store.createInboxItemEntry(inbox.inboxId, item, {
      summary: input.summary,
      subscriptionIds: [],
    });
    this.notifyInboxWatchers(agentId, [entry]);

    const targets = this.store.listActivationTargetsForAgent(agentId).filter((target) => target.status === "active");
    for (const target of targets) {
      this.enqueueActivationTarget(target, {
        agentId,
        subscriptionId: null,
        sourceId: input.sourceId,
        summary: input.summary,
        entry,
      });
    }

    return {
      itemId: item.itemId,
      inboxId: inbox.inboxId,
      activated: targets.length > 0,
    };
  }

  private async materializeInboxEntryForItem(input: {
    agentId: string;
    inbox: Inbox;
    source: SourceStream | null;
    subscriptionId: string | null;
    item: InboxItem;
    summary: string;
  }): Promise<InboxEntry[]> {
    const activationItem = activationItemFromInboxItem(input.item);
    const policy = inboxAggregationPolicy(input.inbox);
    if (!policy.enabled || !input.source) {
      return [this.store.createInboxItemEntry(input.inbox.inboxId, input.item, {
        summary: input.summary,
        subscriptionIds: input.subscriptionId ? [input.subscriptionId] : [],
      })];
    }

    const grouping = await this.adapters.deriveNotificationGrouping(input.source, activationItem);
    if (!grouping?.groupable || !grouping.resourceRef || !grouping.eventFamily) {
      return [this.store.createInboxItemEntry(input.inbox.inboxId, input.item, {
        summary: input.summary,
        subscriptionIds: input.subscriptionId ? [input.subscriptionId] : [],
      })];
    }

    const groupKey = digestGroupKey(input.source.sourceId, grouping.resourceRef, grouping.eventFamily);
    let thread = this.store.getOpenDigestThread(input.inbox.inboxId, groupKey);
    const now = nowIso();
    if (thread && Date.parse(thread.createdAt) + (policy.maxThreadAgeMs ?? DEFAULT_INBOX_AGGREGATION_MAX_THREAD_AGE_MS) <= Date.now()) {
      this.store.closeDigestThread(thread.threadId, now);
      thread = null;
    }
    const flushAfterAt = new Date(Date.now() + (policy.windowMs ?? DEFAULT_INBOX_AGGREGATION_WINDOW_MS)).toISOString();
    if (!thread) {
      thread = this.store.createDigestThread({
        inboxId: input.inbox.inboxId,
        sourceId: input.source.sourceId,
        groupKey,
        resourceRef: grouping.resourceRef,
        eventFamily: grouping.eventFamily,
        summary: grouping.summaryHint ?? input.summary,
        firstItemAt: input.item.occurredAt,
        flushAfterAt,
        createdAt: now,
      });
    } else {
      thread = this.store.addItemToDigestThread(
        thread.threadId,
        input.item.itemId,
        input.item.occurredAt,
        grouping.summaryHint ?? thread.summary,
        flushAfterAt,
      );
    }
    if (!thread || this.store.listUnackedInboxItemsForDigestThread(thread.threadId).find((entry) => entry.itemId === input.item.itemId) == null) {
      thread = this.store.addItemToDigestThread(
        thread.threadId,
        input.item.itemId,
        input.item.occurredAt,
        grouping.summaryHint ?? thread.summary,
        flushAfterAt,
      );
    }

    const unacked = this.store.listUnackedInboxItemsForDigestThread(thread.threadId);
    const shouldFlush = grouping.flushClass === "immediate" || unacked.length >= (policy.maxItems ?? DEFAULT_INBOX_AGGREGATION_MAX_ITEMS);
    if (!shouldFlush) {
      return [];
    }
    const entry = await this.flushDigestThread(input.source, thread.threadId, grouping);
    return entry ? [entry] : [];
  }

  private async flushDigestThread(
    source: SourceStream,
    threadId: string,
    groupingHint?: NotificationGrouping | null,
  ): Promise<InboxEntry | null> {
    const thread = this.store.getDigestThread(threadId);
    if (!thread || thread.status !== "open") {
      return null;
    }
    const items = this.store.listUnackedInboxItemsForDigestThread(threadId);
    if (items.length === 0) {
      this.store.closeDigestThread(threadId, nowIso());
      return null;
    }
    const activationItems = items.map((item) => activationItemFromInboxItem(item));
    const grouping: NotificationGrouping = groupingHint ?? {
      groupable: true,
      resourceRef: thread.resourceRef,
      eventFamily: thread.eventFamily,
      summaryHint: thread.summary,
      flushClass: "normal",
    };
    const moduleSummary = await this.adapters.summarizeDigestThread(source, activationItems, grouping);
    const summary = moduleSummary ?? `${items.length} ${thread.summary}`;
    const sourceIds = uniqueSorted(items.map((item) => item.sourceId));
    const subscriptionIds = uniqueSortedNullable(
      items.map((item) => typeof item.metadata.subscriptionId === "string" ? item.metadata.subscriptionId : null),
    );
    const firstItemAt = items[0]!.occurredAt;
    const lastItemAt = items[items.length - 1]!.occurredAt;
    const deliveryHandle = sharedDeliveryHandle(items);
    return this.store.materializeDigestSnapshot({
      threadId,
      inboxId: thread.inboxId,
      groupKey: thread.groupKey,
      resourceRef: thread.resourceRef,
      eventFamily: thread.eventFamily,
      summary,
      sourceIds,
      subscriptionIds,
      itemIds: items.map((item) => item.itemId),
      firstItemAt,
      lastItemAt,
      deliveryHandleJson: deliveryHandle ? JSON.stringify(deliveryHandle) : null,
      createdAt: nowIso(),
    });
  }

  watchInbox(
    agentId: string,
    options: WatchInboxOptions,
    onEvent: (event: InboxWatchEvent) => void,
  ): InboxWatchSession {
    const inbox = this.ensureInboxForAgent(agentId);
    const pendingItems: InboxEntry[] = [];
    let started = false;

    const emitItems = (entries: InboxEntry[]) => {
      if (entries.length === 0) {
        return;
      }
      onEvent({
        event: "items",
        agentId,
        entries,
      });
    };

    const watcher: InboxWatcher = {
      onItems: (entries) => {
        if (!started) {
          pendingItems.push(...entries);
          return;
        }
        emitItems(entries);
      },
    };

    let watchers = this.inboxWatchers.get(agentId);
    if (!watchers) {
      watchers = new Set();
      this.inboxWatchers.set(agentId, watchers);
    }
    watchers.add(watcher);

    let initialItems: InboxEntry[];
    try {
      initialItems = this.store.listInboxEntries(inbox.inboxId, {
        afterEntryId: options.afterEntryId,
        includeAcked: options.includeAcked ?? false,
      });
    } catch (error) {
      watchers.delete(watcher);
      if (watchers.size === 0) {
        this.inboxWatchers.delete(agentId);
      }
      throw error;
    }

    const initialItemIds = new Set(initialItems.map((item) => item.entryId));
    return {
      initialItems,
      start: () => {
        if (started) {
          return;
        }
        started = true;
        const replayItems = pendingItems.filter((item) => !initialItemIds.has(item.entryId));
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

  async ackInboxItems(agentId: string, itemIds: string[]): Promise<{ acked: number }> {
    const inbox = this.ensureInboxForAgent(agentId);
    const acked = this.store.ackInboxEntries(inbox.inboxId, itemIds, nowIso());
    if (acked.ackedEntries > 0 || acked.ackedItems > 0) {
      await this.handleInboxAckEffects(agentId);
    }
    return { acked: acked.ackedEntries };
  }

  async ackInboxItemsThrough(agentId: string, itemId: string): Promise<{ acked: number }> {
    const inbox = this.ensureInboxForAgent(agentId);
    const acked = this.store.ackInboxEntriesThrough(inbox.inboxId, itemId, nowIso());
    if (acked.ackedEntries > 0 || acked.ackedItems > 0) {
      await this.handleInboxAckEffects(agentId);
    }
    return { acked: acked.ackedEntries };
  }

  async ackAllInboxItems(agentId: string): Promise<{ acked: number }> {
    const inbox = this.ensureInboxForAgent(agentId);
    const itemIds = this.store.listInboxEntries(inbox.inboxId, { includeAcked: false }).map((item) => item.entryId);
    const acked = this.store.ackInboxEntries(inbox.inboxId, itemIds, nowIso());
    if (acked.ackedEntries > 0 || acked.ackedItems > 0) {
      await this.handleInboxAckEffects(agentId);
    }
    return { acked: acked.ackedEntries };
  }

  async ackInbox(agentId: string, input: {
    entryIds?: string[];
    throughEntryId?: string | null;
    all?: boolean;
  }): Promise<{ acked: number }> {
    if (input.all) {
      return this.ackAllInboxItems(agentId);
    }
    const throughEntryId = input.throughEntryId ?? null;
    if (throughEntryId) {
      return this.ackInboxItemsThrough(agentId, throughEntryId);
    }
    return this.ackInboxItems(agentId, input.entryIds ?? []);
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

  gc(): { deleted: number; retentionMs: number; removedAgents: number; removedSubscriptions: number } {
    const acked = this.gcAckedInboxItems();
    const lifecycle = this.runLifecycleCleanupPass(Date.now());
    const offlineAgents = this.gcOfflineAgents();
    return {
      deleted: acked.deleted,
      retentionMs: acked.retentionMs,
      removedAgents: offlineAgents.removedAgents,
      removedSubscriptions: lifecycle.removedSubscriptions,
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
      const insertedEntries: InboxEntry[] = [];
      const lifecycleSignals = new Map<string, LifecycleSignal>();
      try {
        for (const event of batch.events) {
          lastProcessedOffset = event.offset;
          await this.collectLifecycleSignal(source, event.rawPayload, lifecycleSignals, event.occurredAt);
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
            itemId: generateCanonicalId("itm"),
            sourceId: event.sourceId,
            sourceNativeId: event.sourceNativeId,
            eventVariant: event.eventVariant,
            inboxId: inbox.inboxId,
            occurredAt: event.occurredAt,
            metadata: {
              ...event.metadata,
              matchReason: match.reason,
              agentId: subscription.agentId,
              subscriptionId: subscription.subscriptionId,
            },
            rawPayload: event.rawPayload,
            deliveryHandle: event.deliveryHandle as DeliveryHandle | null,
            ackedAt: null,
          };
          const inserted = this.store.insertInboxItem(item);
          if (!inserted) {
            continue;
          }
          inboxItemsCreated += 1;
          const entries = await this.materializeInboxEntryForItem({
            agentId: subscription.agentId,
            inbox,
            source,
            subscriptionId: subscription.subscriptionId,
            item,
            summary: summarizeSourceEvent(source.sourceType, source.sourceKey, event.eventVariant),
          });
          insertedEntries.push(...entries);
          for (const entry of entries) {
            for (const target of targets) {
              this.enqueueActivationTarget(target, {
                agentId: subscription.agentId,
                subscriptionId: subscription.subscriptionId,
                sourceId: source.sourceId,
                summary: entry.summary,
                entry,
              });
            }
          }
        }
      } catch (error) {
        if (insertedEntries.length > 0) {
          this.notifyInboxWatchers(subscription.agentId, insertedEntries);
        }
        if (lastProcessedOffset != null) {
          await this.backend.commit({
            consumerId: consumer.consumerId,
            committedOffset: lastProcessedOffset,
          });
        }
        throw error;
      }

      if (insertedEntries.length > 0) {
        this.notifyInboxWatchers(subscription.agentId, insertedEntries);
      }
      if (lastProcessedOffset != null) {
        await this.backend.commit({
          consumerId: consumer.consumerId,
          committedOffset: lastProcessedOffset,
        });
      }
      for (const signal of lifecycleSignals.values()) {
        this.scheduleLifecycleRetirements(source, signal);
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
    const source = resolveDeliverySource(this.store, request.sourceId, handle);
    const attempt: DeliveryAttempt = {
      deliveryId: generateCanonicalId("dlv"),
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
    const result = source
      ? await this.sendCanonicalDeliveryViaModule(source, handle, request.payload, attempt)
      : await this.adapters.deliveryAdapterFor(handle.provider).send(request, attempt);
    const storedAttempt = { ...attempt, status: result.status };
    this.store.insertDelivery(storedAttempt);
    return { ...storedAttempt, note: result.note };
  }

  async listDeliveryActions(
    request: DeliveryActionsRequest,
  ): Promise<{ sourceId: string | null; handle: DeliveryHandle; operations: DeliveryOperationDescriptor[] }> {
    const handle = resolveDeliveryHandle(request);
    const source = resolveDeliverySource(this.store, request.sourceId, handle);
    const operations = await this.adapters.listDeliveryOperations(source, handle);
    return {
      sourceId: source?.sourceId ?? null,
      handle,
      operations,
    };
  }

  async invokeDelivery(
    request: DeliveryInvokeRequest,
  ): Promise<DeliveryAttempt & { note: string; operation: string }> {
    const handle = resolveDeliveryHandle(request);
    const source = resolveDeliverySource(this.store, request.sourceId, handle);
    const attempt: DeliveryAttempt = {
      deliveryId: generateCanonicalId("dlv"),
      provider: handle.provider,
      surface: handle.surface,
      targetRef: handle.targetRef,
      threadRef: handle.threadRef ?? null,
      replyMode: handle.replyMode ?? null,
      kind: request.operation,
      payload: request.input,
      status: "accepted",
      createdAt: nowIso(),
    };
    const result = await this.adapters.invokeDeliveryOperation(source, handle, request.operation, request.input, attempt);
    const storedAttempt = { ...attempt, status: result.status };
    this.store.insertDelivery(storedAttempt);
    return { ...storedAttempt, note: result.note, operation: request.operation };
  }

  private async sendCanonicalDeliveryViaModule(
    source: SourceStream,
    handle: DeliveryHandle,
    payload: Record<string, unknown>,
    attempt: DeliveryAttempt,
  ): Promise<{ status: DeliveryAttempt["status"]; note: string }> {
    const operations = await this.adapters.listDeliveryOperations(source, handle);
    const canonicalOperation = operations.find((operation) => operation.canonicalTextAlias);
    if (!canonicalOperation) {
      throw new Error(`deliver send is not supported for ${handle.provider}/${handle.surface}; use deliver invoke`);
    }
    const input = payload.text != null ? { ...payload, body: String(payload.text) } : payload;
    return this.adapters.invokeDeliveryOperation(source, handle, canonicalOperation.name, input, attempt);
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
      inboxId: generateCanonicalId("inb"),
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

  private async ensureStreamForSource(source: SourceStream) {
    return this.backend.ensureStream({
      sourceId: source.sourceId,
      streamKey: streamKeyForSource(source.sourceId),
      backend: "sqlite",
    });
  }

  private async collectLifecycleSignal(
    source: SourceStream,
    rawPayload: Record<string, unknown>,
    signals: Map<string, LifecycleSignal>,
    fallbackOccurredAt?: string,
  ): Promise<void> {
    const signal = await this.adapters.projectLifecycleSignal(source, rawPayload);
    if (!signal || !signal.terminal) {
      return;
    }
    const normalized = normalizeLifecycleSignal(signal, fallbackOccurredAt);
    if (!normalized) {
      return;
    }
    const existing = signals.get(normalized.ref);
    if (!existing) {
      signals.set(normalized.ref, normalized);
      return;
    }
    const existingAt = Date.parse(existing.occurredAt ?? "");
    const normalizedAt = Date.parse(normalized.occurredAt ?? "");
    if (Number.isNaN(existingAt) || (!Number.isNaN(normalizedAt) && normalizedAt > existingAt)) {
      signals.set(normalized.ref, normalized);
    }
  }

  private scheduleLifecycleRetirements(source: SourceStream, signal: LifecycleSignal): void {
    if (!signal.terminal) {
      return;
    }
    if (!source.hostId) {
      return;
    }
    const signalOccurredAt = signal.occurredAt ?? nowIso();
    const signalOccurredAtMs = Date.parse(signalOccurredAt);
    for (const subscription of this.store.listSubscriptions()) {
      if (!subscription.trackedResourceRef || subscription.trackedResourceRef !== signal.ref) {
        continue;
      }
      const subscriptionSource = this.store.getSource(subscription.sourceId);
      if (!subscriptionSource || subscriptionSource.hostId !== source.hostId) {
        continue;
      }
      const retireAt = lifecycleRetireAtForSignal(subscription.cleanupPolicy, signalOccurredAtMs);
      if (!retireAt) {
        continue;
      }
      const now = nowIso();
      this.store.upsertSubscriptionLifecycleRetirement({
        subscriptionId: subscription.subscriptionId,
        hostId: source.hostId,
        trackedResourceRef: signal.ref,
        retireAt,
        terminalState: signal.state ?? null,
        terminalResult: signal.result ?? null,
        terminalOccurredAt: signalOccurredAt,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private notifyInboxWatchers(agentId: string, items: InboxEntry[]): void {
    const watchers = this.inboxWatchers.get(agentId);
    if (!watchers || watchers.size === 0) {
      return;
    }
    for (const watcher of watchers) {
      watcher.onItems(items);
    }
  }

  private resolveAutoAgentId(input: {
    runtimeKind?: Agent["runtimeKind"] | null;
    runtimeSessionId?: string | null;
    backend: RegisterAgentInput["backend"];
    tmuxPaneId?: string | null;
    itermSessionId?: string | null;
    tty?: string | null;
  }): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = assignedAgentIdFromContext({
        runtimeKind: input.runtimeKind,
        runtimeSessionId: input.runtimeSessionId,
        backend: input.backend,
        tmuxPaneId: input.tmuxPaneId,
        itermSessionId: input.itermSessionId,
        tty: input.tty,
      }, attempt);
      const existing = this.store.getAgent(candidate);
      if (!existing) {
        return candidate;
      }
      const targets = this.store
        .listActivationTargetsForAgent(candidate)
        .filter((target): target is TerminalActivationTarget => target.kind === "terminal");
      if (targets.length === 0 || targets.some((target) => isSameTerminalIdentity(target, input))) {
        return candidate;
      }
    }
    throw new Error("unable to derive a unique agentId from terminal context");
  }

  private handleAgentRegistrationConflicts(agentId: string, input: RegisterAgentInput): void {
    const currentTarget = findExistingTerminalActivationTarget(this.store, input);
    if (currentTarget && currentTarget.agentId !== agentId) {
      if (!input.forceRebind) {
        throw new Error(
          `agent register conflict: current terminal target ${currentTarget.targetId} is already bound to agent ${currentTarget.agentId}; retry with forceRebind to rebind`,
        );
      }
      this.store.deleteActivationTarget(currentTarget.agentId, currentTarget.targetId);
      this.reconcileAgentStatus(currentTarget.agentId);
    }

    const conflictingTargets = this.store
      .listActivationTargetsForAgent(agentId)
      .filter((target): target is TerminalActivationTarget => target.kind === "terminal")
      .filter((target) => !isSameTerminalIdentity(target, input));

    if (conflictingTargets.length > 0 && !input.forceRebind) {
      throw new Error(
        `agent register conflict: agent ${agentId} is already bound to terminal target ${conflictingTargets[0].targetId}; retry with forceRebind to rebind`,
      );
    }

    if (input.forceRebind) {
      for (const target of conflictingTargets) {
        this.store.deleteActivationTarget(agentId, target.targetId);
      }
    }
  }

  private upsertTerminalActivationTarget(agentId: string, input: RegisterAgentInput, now: string): TerminalActivationTarget {
    const existing = findExistingTerminalActivationTarget(this.store, input);
    if (existing) {
      const existingPolicy = notificationPolicyForTarget(existing);
      const target = this.store.updateTerminalActivationTargetHeartbeat(existing.targetId, {
        runtimeKind: input.runtimeKind ?? "unknown",
        runtimeSessionId: input.runtimeSessionId ?? null,
        runtimePid: input.runtimePid ?? null,
        tmuxPaneId: input.tmuxPaneId ?? null,
        tty: input.tty ?? null,
        termProgram: input.termProgram ?? null,
        itermSessionId: input.itermSessionId ?? null,
        notifyLeaseMs: input.notifyLeaseMs ?? existingPolicy.notifyLeaseMs,
        minUnackedItems: input.minUnackedItems ?? existingPolicy.minUnackedItems ?? null,
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
      targetId: generateCanonicalId("tgt"),
      agentId,
      kind: "terminal",
      status: "active",
      offlineSince: null,
      consecutiveFailures: 0,
      lastDeliveredAt: null,
      lastError: null,
      mode: "agent_prompt",
      notifyLeaseMs: input.notifyLeaseMs ?? DEFAULT_NOTIFY_LEASE_MS,
      minUnackedItems: input.minUnackedItems ?? null,
      notificationPolicy: {
        notifyLeaseMs: input.notifyLeaseMs ?? DEFAULT_NOTIFY_LEASE_MS,
        minUnackedItems: input.minUnackedItems ?? null,
      },
      runtimeKind: input.runtimeKind ?? "unknown",
      runtimeSessionId: input.runtimeSessionId ?? null,
      runtimePid: input.runtimePid ?? null,
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
      subscriptionId: string | null;
      sourceId: string;
      summary: string;
      entry: InboxEntry;
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
      entry: input.entry,
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
    this.store.deleteSubscriptionLifecycleRetirement(subscription.subscriptionId);
  }

  private async flushAllPendingNotifications(): Promise<void> {
    const keys = Array.from(this.notificationBuffers.keys());
    for (const key of keys) {
      await this.flushNotificationBuffer(key);
    }
  }

  private async awaitInFlightNotificationBuffers(): Promise<void> {
    while (true) {
      const activeBuffers = Array.from(this.notificationBuffers.values());
      if (activeBuffers.every((buffer) => !buffer.inFlight)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      const shouldAttemptDispatch = !state || (state.status === "dirty" && state.leaseExpiresAt == null);
      if (shouldAttemptDispatch) {
        const inbox = this.ensureInboxForAgent(buffer.agentId);
        const unackedItems = this.store.listInboxEntries(inbox.inboxId, { includeAcked: false });
        const dispatched = await this.dispatchActivationTarget({
          agentId: buffer.agentId,
          targetId: buffer.targetId,
          newItemCount: state ? state.pendingNewItemCount + entries.length : entries.length,
          totalUnackedCount: unackedItems.length,
          summary: state ? latestSummary(entries) ?? state.pendingSummary : latestSummary(entries),
          subscriptionIds: state
            ? uniqueSortedNullable([...state.pendingSubscriptionIds, ...entries.map((entry) => entry.subscriptionId)])
            : uniqueSortedNullable(entries.map((entry) => entry.subscriptionId)),
          sourceIds: state
            ? uniqueSorted([...state.pendingSourceIds, ...entries.map((entry) => entry.sourceId)])
            : uniqueSorted(entries.map((entry) => entry.sourceId)),
          entries: unackedItems,
        });
        if (dispatched === "retryable_failure") {
          if (state && state.status === "dirty" && state.leaseExpiresAt == null) {
            this.store.upsertActivationDispatchState({
              agentId: buffer.agentId,
              targetId: buffer.targetId,
              status: "dirty",
              leaseExpiresAt: new Date(Date.now() + DEFAULT_NOTIFY_RETRY_MS).toISOString(),
              lastNotifiedFingerprint: state.lastNotifiedFingerprint,
              deferReason: null,
              deferAttempts: 0,
              firstDeferredAt: null,
              lastDeferredAt: null,
              pendingFingerprint: null,
              pendingNewItemCount: state.pendingNewItemCount + entries.length,
              pendingSummary: latestSummary(entries) ?? state.pendingSummary,
              pendingSubscriptionIds: uniqueSortedNullable([...state.pendingSubscriptionIds, ...entries.map((entry) => entry.subscriptionId)]),
              pendingSourceIds: uniqueSorted([...state.pendingSourceIds, ...entries.map((entry) => entry.sourceId)]),
              updatedAt: nowIso(),
            });
          } else {
            this.upsertDirtyDispatchState(buffer.agentId, buffer.targetId, entries);
          }
        }
      } else {
        const mergedNewItemCount = state.pendingNewItemCount + entries.length;
        const mergedSummary = latestSummary(entries) ?? state.pendingSummary;
        const mergedSubscriptionIds = uniqueSortedNullable([...state.pendingSubscriptionIds, ...entries.map((entry) => entry.subscriptionId)]);
        const mergedSourceIds = uniqueSorted([...state.pendingSourceIds, ...entries.map((entry) => entry.sourceId)]);
        let deferReason = state.deferReason;
        let deferAttempts = state.deferAttempts;
        let firstDeferredAt = state.firstDeferredAt;
        let lastDeferredAt = state.lastDeferredAt;
        let pendingFingerprint = state.pendingFingerprint;
        let leaseExpiresAt = state.leaseExpiresAt;
        if (state.status === "dirty" && state.leaseExpiresAt != null && state.deferReason) {
          pendingFingerprint = null;
          this.logger.debug("activation.defer_pending_marked_stale", {
            agentId: buffer.agentId,
            targetId: buffer.targetId,
            deferReason: state.deferReason,
            deferAttempts: state.deferAttempts,
          });
        }
        this.store.upsertActivationDispatchState({
          agentId: buffer.agentId,
          targetId: buffer.targetId,
          status: "dirty",
          leaseExpiresAt,
          lastNotifiedFingerprint: state.lastNotifiedFingerprint,
          deferReason,
          deferAttempts,
          firstDeferredAt,
          lastDeferredAt,
          pendingFingerprint,
          pendingNewItemCount: mergedNewItemCount,
          pendingSummary: mergedSummary,
          pendingSubscriptionIds: mergedSubscriptionIds,
          pendingSourceIds: mergedSourceIds,
          updatedAt: nowIso(),
        });
      }

      const hasPendingDuringFlight = buffer.pending.length > 0;
      buffer.inFlight = false;
      if (hasPendingDuringFlight) {
        if (!this.stopping) {
          buffer.timer = setTimeout(() => {
            void this.flushNotificationBuffer(key);
          }, this.activationWindowMs);
        }
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
    await this.reconcileDigestThreadsForInbox(this.ensureInboxForAgent(agentId).inboxId);
    const states = this.store.listActivationDispatchStatesForAgent(agentId);
    for (const state of states) {
      await this.maybeDispatchActivationTarget(agentId, state.targetId, "ack");
    }
  }

  private async reconcileDigestThreadsForInbox(inboxId: string): Promise<void> {
    for (const thread of this.store.listOpenDigestThreadsForInbox(inboxId)) {
      const source = this.store.getSource(thread.sourceId);
      if (!source) {
        this.store.closeDigestThread(thread.threadId, nowIso());
        continue;
      }
      const items = this.store.listUnackedInboxItemsForDigestThread(thread.threadId);
      if (items.length === 0) {
        this.store.closeDigestThread(thread.threadId, nowIso());
        continue;
      }
      const head = thread.latestEntryId != null ? this.store.getInboxEntry(thread.latestEntryId) : null;
      const currentIds = items.map((item) => item.itemId);
      const headIds = head?.itemIds ?? [];
      if (!sameStringArray(currentIds, headIds)) {
        await this.flushDigestThread(source, thread.threadId);
      }
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

    const target = this.getActivationTarget(targetId);
    const inbox = this.ensureInboxForAgent(agentId);
    const unacked = this.store.listInboxEntries(inbox.inboxId, { includeAcked: false }).length;
    if (unacked === 0) {
      this.store.deleteActivationDispatchState(agentId, targetId);
      return;
    }

    if (!meetsNotificationThreshold(notificationPolicyForTarget(target), unacked)) {
      this.store.upsertActivationDispatchState({
        ...state,
        status: "dirty",
        leaseExpiresAt: null,
        deferReason: null,
        deferAttempts: 0,
        firstDeferredAt: null,
        lastDeferredAt: null,
        pendingFingerprint: null,
        pendingNewItemCount: state.pendingNewItemCount > 0 ? state.pendingNewItemCount : unacked,
        updatedAt: nowIso(),
      });
      return;
    }

    if (reason === "ack" && state.status !== "dirty") {
      return;
    }
    if (reason === "lease" && state.status === "notified") {
      if (target.kind !== "terminal") {
        // Webhook targets keep the existing lease-based behavior.
      } else {
        this.store.upsertActivationDispatchState({
          ...state,
          leaseExpiresAt: new Date(Date.now() + target.notifyLeaseMs).toISOString(),
          updatedAt: nowIso(),
        });
        return;
      }
    }

    const dispatched = await this.dispatchActivationTarget({
      agentId,
      targetId,
      newItemCount: state.pendingNewItemCount > 0 ? state.pendingNewItemCount : unacked,
      totalUnackedCount: unacked,
      summary: state.pendingSummary,
      subscriptionIds: state.pendingSubscriptionIds,
      sourceIds: state.pendingSourceIds,
      entries: this.store.listInboxEntries(inbox.inboxId, { includeAcked: false }),
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
        deferReason: null,
        deferAttempts: 0,
        firstDeferredAt: null,
        lastDeferredAt: null,
        pendingFingerprint: null,
        updatedAt: nowIso(),
      });
    }
  }

  private async dispatchActivationTarget(input: {
    agentId: string;
    targetId: string;
    newItemCount: number;
    totalUnackedCount?: number;
    summary: string | null;
    subscriptionIds: string[];
    sourceIds: string[];
    entries: InboxEntry[];
  }): Promise<ActivationDispatchOutcome> {
    const target = this.getActivationTarget(input.targetId);
    if (target.status === "offline") {
      return "offline";
    }
    const state = this.store.getActivationDispatchState(input.agentId, input.targetId);
    const inbox = this.ensureInboxForAgent(input.agentId);
    const summary = summarizeActivation(inbox.inboxId, input.newItemCount, input.summary);
    const totalUnackedCount = input.totalUnackedCount ?? this.store.listInboxEntries(inbox.inboxId, { includeAcked: false }).length;
    const notificationPolicy = notificationPolicyForTarget(target);
    if (!meetsNotificationThreshold(notificationPolicy, totalUnackedCount)) {
      this.logger.debug("activation.dispatch_suppressed", {
        agentId: input.agentId,
        targetId: target.targetId,
        reason: "min_unacked_items",
        totalUnackedCount,
        minUnackedItems: notificationPolicy.minUnackedItems ?? null,
      });
      this.store.upsertActivationDispatchState({
        agentId: input.agentId,
        targetId: input.targetId,
        status: "dirty",
        leaseExpiresAt: null,
        lastNotifiedFingerprint: state?.lastNotifiedFingerprint ?? null,
        deferReason: null,
        deferAttempts: 0,
        firstDeferredAt: null,
        lastDeferredAt: null,
        pendingFingerprint: null,
        pendingNewItemCount: input.newItemCount,
        pendingSummary: input.summary,
        pendingSubscriptionIds: uniqueSortedNullable(input.subscriptionIds),
        pendingSourceIds: uniqueSorted(input.sourceIds),
        updatedAt: nowIso(),
      });
      return "suppressed";
    }
    let terminalPrompt: string | null = null;
    let terminalPromptFingerprint: string | null = null;
    try {
      if (target.kind === "terminal") {
        const gate = await this.activationGate.evaluate(target);
        this.logger.debug("activation.gate_decision", {
          agentId: input.agentId,
          targetId: target.targetId,
          runtimeKind: target.runtimeKind,
          backend: target.backend,
          outcome: gate.outcome,
          reason: gate.reason,
        });
        if (gate.outcome === "offline") {
          this.logger.info("activation.target_offline", {
            agentId: input.agentId,
            targetId: target.targetId,
            reason: gate.reason,
            transition: "runtime_gate",
          });
          this.markActivationTargetOffline(target.targetId, `runtime gate: ${gate.reason}`);
          this.reconcileAgentStatus(target.agentId);
          return "offline";
        }
        const reminder = await this.buildTerminalReminder(
          target,
          inbox.inboxId,
          totalUnackedCount,
          input.summary,
          input.entries,
        );
        const prompt = reminder.prompt;
        const promptFingerprint = reminder.fingerprint;
        terminalPrompt = prompt;
        terminalPromptFingerprint = promptFingerprint;
        if (gate.outcome === "defer") {
          const deferReason = toActivationDispatchDeferReason(gate.reason, this.logger);
          const hasExistingDeferred = state?.deferReason != null;
          const deferAttempts = hasExistingDeferred ? state.deferAttempts + 1 : 1;
          const deferredAt = nowIso();
          const retryMs = terminalDeferRetryMs(deferAttempts);
          const existingLeaseMs = state?.leaseExpiresAt == null ? Number.NaN : Date.parse(state.leaseExpiresAt);
          const candidateLeaseMs = Date.now() + retryMs;
          const nextLeaseMs = Number.isNaN(existingLeaseMs)
            ? candidateLeaseMs
            : Math.max(existingLeaseMs, candidateLeaseMs);
          this.logger.debug("activation.dispatch_deferred", {
            agentId: input.agentId,
            targetId: target.targetId,
            reason: deferReason,
            retryMs,
            deferAttempts,
            pendingFingerprint: promptFingerprint,
          });
          this.store.upsertActivationDispatchState({
            agentId: input.agentId,
            targetId: input.targetId,
            status: "dirty",
            leaseExpiresAt: new Date(nextLeaseMs).toISOString(),
            lastNotifiedFingerprint: state?.lastNotifiedFingerprint ?? null,
            deferReason,
            deferAttempts,
            firstDeferredAt: state?.firstDeferredAt ?? deferredAt,
            lastDeferredAt: deferredAt,
            pendingFingerprint: promptFingerprint,
            pendingNewItemCount: input.newItemCount,
            pendingSummary: input.summary,
            pendingSubscriptionIds: uniqueSortedNullable(input.subscriptionIds),
            pendingSourceIds: uniqueSorted(input.sourceIds),
            updatedAt: nowIso(),
          });
          return "deferred";
        }
        if (state?.pendingFingerprint && state.pendingFingerprint !== promptFingerprint) {
          this.logger.debug("activation.defer_pending_revalidated", {
            agentId: input.agentId,
            targetId: target.targetId,
            previousFingerprint: state.pendingFingerprint,
            currentFingerprint: promptFingerprint,
          });
        }
        if (state?.lastNotifiedFingerprint === promptFingerprint) {
          this.logger.debug("activation.dispatch_suppressed", {
            agentId: input.agentId,
            targetId: target.targetId,
            reason: "unchanged_terminal_prompt",
            status: state.status,
          });
          this.store.upsertActivationDispatchState({
            agentId: input.agentId,
            targetId: input.targetId,
            status: "notified",
            leaseExpiresAt: new Date(Date.now() + target.notifyLeaseMs).toISOString(),
            lastNotifiedFingerprint: promptFingerprint,
            deferReason: null,
            deferAttempts: 0,
            firstDeferredAt: null,
            lastDeferredAt: null,
            pendingFingerprint: null,
            pendingNewItemCount: 0,
            pendingSummary: null,
            pendingSubscriptionIds: [],
            pendingSourceIds: [],
            updatedAt: nowIso(),
          });
          return "suppressed";
        }
        this.logger.debug("activation.terminal_dispatch_start", {
          agentId: input.agentId,
          targetId: target.targetId,
          totalUnackedCount,
          newItemCount: input.newItemCount,
          sourceIds: input.sourceIds,
          subscriptionIds: input.subscriptionIds,
        });
        await this.terminalDispatcher.dispatch(target, prompt);
        this.logger.debug("activation.terminal_dispatch_succeeded", {
          agentId: input.agentId,
          targetId: target.targetId,
        });
      } else {
        const activation: Activation = {
          kind: "agentinbox.activation",
          activationId: generateCanonicalId("act"),
          agentId: input.agentId,
          inboxId: inbox.inboxId,
          targetId: target.targetId,
          targetKind: target.kind,
          subscriptionIds: input.subscriptionIds,
          sourceIds: input.sourceIds,
          newEntryCount: input.entries.length,
          newItemCount: input.newItemCount,
          summary,
          items: target.mode === "activation_with_items"
            ? input.entries
              .filter((entry): entry is Extract<InboxEntry, { kind: "item" }> => entry.kind === "item")
              .map((entry) => entry.item)
            : undefined,
          entries: target.mode === "activation_with_items" && input.entries.length > 0 ? input.entries : undefined,
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
        lastNotifiedFingerprint: target.kind === "terminal"
          ? terminalPromptFingerprint
          : state?.lastNotifiedFingerprint ?? null,
        deferReason: null,
        deferAttempts: 0,
        firstDeferredAt: null,
        lastDeferredAt: null,
        pendingFingerprint: null,
        pendingNewItemCount: 0,
        pendingSummary: null,
        pendingSubscriptionIds: [],
        pendingSourceIds: [],
        updatedAt: nowIso(),
      });
      return "dispatched";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("activation.dispatch_failed", {
        agentId: input.agentId,
        targetId: target.targetId,
        targetKind: target.kind,
        error,
        message,
      });
      if (target.kind === "terminal") {
        const exists = await this.terminalDispatcher.probe(target);
        this.logger.debug("activation.terminal_probe_after_failure", {
          agentId: input.agentId,
          targetId: target.targetId,
          exists,
        });
        if (!exists) {
          this.logger.info("activation.target_offline", {
            agentId: input.agentId,
            targetId: target.targetId,
            reason: message,
            transition: "dispatch_probe",
          });
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
    entries: Array<{ subscriptionId: string | null; sourceId: string; summary: string }>,
  ): void {
    this.store.upsertActivationDispatchState({
      agentId,
      targetId,
      status: "dirty",
      leaseExpiresAt: new Date(Date.now() + DEFAULT_NOTIFY_RETRY_MS).toISOString(),
      lastNotifiedFingerprint: this.store.getActivationDispatchState(agentId, targetId)?.lastNotifiedFingerprint ?? null,
      deferReason: null,
      deferAttempts: 0,
      firstDeferredAt: null,
      lastDeferredAt: null,
      pendingFingerprint: null,
      pendingNewItemCount: entries.length,
      pendingSummary: latestSummary(entries),
      pendingSubscriptionIds: uniqueSortedNullable(entries.map((entry) => entry.subscriptionId)),
      pendingSourceIds: uniqueSorted(entries.map((entry) => entry.sourceId)),
      updatedAt: nowIso(),
    });
  }

  private async buildTerminalReminder(
    target: TerminalActivationTarget,
    inboxId: string,
    totalUnackedCount: number,
    summary: string | null,
    entries: InboxEntry[],
  ): Promise<{ prompt: string; fingerprint: string }> {
    let preview: string | null = null;
    if (totalUnackedCount === 1 && entries.length === 1 && entries[0]?.kind === "item") {
      const singleItem = entries[0].item;
      const source = this.store.getSource(singleItem.sourceId);
      if (source) {
        try {
          const sourcePreview = await this.adapters.deriveInlinePreview(source, singleItem);
          preview = typeof sourcePreview === "string" ? normalizeInlinePreviewText(sourcePreview) : null;
        } catch {
          preview = null;
        }
      }
      preview ??= deriveInlineItemPreview(singleItem, summary);
    }
    const prompt = renderAgentPrompt({
      inboxId,
      totalUnackedCount,
      summary,
      preview,
    });
    return {
      prompt,
      fingerprint: terminalReminderFingerprint(prompt, entries),
    };
  }

  private detectDirectInboxSender(env: NodeJS.ProcessEnv): string | null {
    try {
      const detected = detectTerminalContext(env);
      const target = findExistingTerminalActivationTarget(this.store, {
        runtimeKind: detected.runtimeKind,
        runtimeSessionId: detected.runtimeSessionId ?? null,
        runtimePid: detected.runtimePid ?? null,
        backend: detected.backend,
        tmuxPaneId: detected.tmuxPaneId ?? null,
        tty: detected.tty ?? null,
        termProgram: detected.termProgram ?? null,
        itermSessionId: detected.itermSessionId ?? null,
      });
      if (target) {
        return target.agentId;
      }
      return detected.runtimeSessionId
        ?? detected.tmuxPaneId
        ?? detected.itermSessionId
        ?? detected.tty
        ?? null;
    } catch {
      return null;
    }
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

  private async resumeTerminalActivationTarget(target: TerminalActivationTarget): Promise<ResumeActivationTargetResult> {
    const probeStatus = await this.terminalDispatcher.probeStatus(target);
    const now = nowIso();
    if (probeStatus === "available") {
      this.store.updateActivationTargetRuntime(target.targetId, {
        status: "active",
        offlineSince: null,
        consecutiveFailures: 0,
        lastError: null,
        updatedAt: now,
        lastSeenAt: now,
      });
      return {
        targetId: target.targetId,
        resumed: true,
        status: "active",
        reason: "terminal_available",
      };
    }
    if (probeStatus === "gone") {
      this.store.updateActivationTargetRuntime(target.targetId, {
        status: "offline",
        offlineSince: target.offlineSince ?? now,
        updatedAt: now,
        lastError: target.lastError ?? "terminal gone",
      });
      return {
        targetId: target.targetId,
        resumed: false,
        status: "offline",
        reason: "terminal_gone",
      };
    }
    return {
      targetId: target.targetId,
      resumed: false,
      status: "offline",
      reason: "probe_unknown",
    };
  }

  private runLifecycleCleanupPass(nowMs: number): { removedSubscriptions: number; affectedSourceIds: string[] } {
    this.lastLifecycleCleanupAt = nowMs;
    const removed = new Set<string>();
    const affectedSourceIds = new Set<string>();

    for (const subscription of this.store.listSubscriptions()) {
      if (removed.has(subscription.subscriptionId)) {
        continue;
      }
      const deadline = lifecycleDeadlineAt(subscription.cleanupPolicy);
      if (!deadline) {
        continue;
      }
      const deadlineMs = Date.parse(deadline);
      if (Number.isNaN(deadlineMs) || deadlineMs > nowMs) {
        continue;
      }
      if (this.store.deleteSubscription(subscription.subscriptionId)) {
        removed.add(subscription.subscriptionId);
        affectedSourceIds.add(subscription.sourceId);
        this.clearSubscriptionRuntimeState(subscription);
      }
    }

    const dueRetirements = this.store.listSubscriptionLifecycleRetirementsDue(new Date(nowMs).toISOString());
    for (const retirement of dueRetirements) {
      if (removed.has(retirement.subscriptionId)) {
        this.store.deleteSubscriptionLifecycleRetirement(retirement.subscriptionId);
        continue;
      }
      const subscription = this.store.getSubscription(retirement.subscriptionId);
      if (!subscription) {
        this.store.deleteSubscriptionLifecycleRetirement(retirement.subscriptionId);
        continue;
      }
      if (this.store.deleteSubscription(retirement.subscriptionId)) {
        removed.add(retirement.subscriptionId);
        affectedSourceIds.add(subscription.sourceId);
        this.clearSubscriptionRuntimeState(subscription);
      }
    }

    return {
      removedSubscriptions: removed.size,
      affectedSourceIds: [...affectedSourceIds],
    };
  }

  private async runIdleSourceCleanupPass(nowMs: number): Promise<void> {
    const now = new Date(nowMs).toISOString();
    const due = this.store.listSourceIdleStatesDue(now);
    for (const idleState of due) {
      const source = this.store.getSource(idleState.sourceId);
      if (!source) {
        this.store.deleteSourceIdleState(idleState.sourceId);
        continue;
      }
      if (this.store.listSubscriptionsForSource(source.sourceId).length > 0) {
        this.store.deleteSourceIdleState(source.sourceId);
        continue;
      }
      const sourceAdapter = this.adapters.sourceAdapterFor(source.sourceType);
      if (!sourceAdapter.pauseSource) {
        this.store.deleteSourceIdleState(source.sourceId);
        continue;
      }
      if (source.status === "paused") {
        if (!idleState.autoPausedAt) {
          this.store.upsertSourceIdleState({
            ...idleState,
            autoPausedAt: now,
            updatedAt: now,
          });
        }
        continue;
      }
      await this.adapters.pauseSource(source);
      if (this.store.getSource(source.sourceId)?.status !== "paused") {
        this.store.updateSourceRuntime(source.sourceId, { status: "paused" });
      }
      this.store.upsertSourceIdleState({
        ...idleState,
        autoPausedAt: now,
        updatedAt: now,
      });
    }
  }

  private gcOfflineAgents(now = Date.now()): { removedAgents: number } {
    const cutoffIso = new Date(now - DEFAULT_OFFLINE_AGENT_TTL_MS).toISOString();
    const agents = this.store.listOfflineAgentsOlderThan(cutoffIso);
    const affectedSourceIds = new Set<string>();
    for (const agent of agents) {
      for (const subscription of this.store.listSubscriptionsForAgent(agent.agentId)) {
        affectedSourceIds.add(subscription.sourceId);
      }
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
    for (const sourceId of affectedSourceIds) {
      this.refreshSourceIdleState(sourceId);
    }
    if (agents.length > 0) {
      this.store.save();
    }
    if (agents.length > 0) {
      this.rescheduleTimerSync();
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

  private async syncPendingDigestThreads(force = false): Promise<void> {
    const now = nowIso();
    const threads = force
      ? this.store.listOpenDigestThreads()
      : this.store.listDueDigestThreads(now);
    for (const thread of threads) {
      try {
        const source = this.store.getSource(thread.sourceId);
        if (!source) {
          this.store.closeDigestThread(thread.threadId, now);
          continue;
        }
        const entry = await this.flushDigestThread(source, thread.threadId);
        if (!entry) {
          continue;
        }
        const inbox = this.store.getInbox(thread.inboxId);
        if (!inbox) {
          continue;
        }
        this.notifyInboxWatchers(inbox.ownerAgentId, [entry]);
        const targets = this.store.listActivationTargetsForAgent(inbox.ownerAgentId).filter((target) => target.status === "active");
        for (const target of targets) {
          this.enqueueActivationTarget(target, {
            agentId: inbox.ownerAgentId,
            subscriptionId: null,
            sourceId: thread.sourceId,
            summary: entry.summary,
            entry,
          });
        }
      } catch (error) {
        console.warn(`digest thread flush failed for ${thread.threadId}:`, error);
      }
    }
  }

  private async syncLifecycleGc(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLifecycleCleanupAt >= DEFAULT_GC_INTERVAL_MS) {
      try {
        const lifecycle = this.runLifecycleCleanupPass(now);
        for (const sourceId of lifecycle.affectedSourceIds) {
          this.refreshSourceIdleState(sourceId);
        }
        await this.runIdleSourceCleanupPass(now);
      } catch (error) {
        console.warn("subscription lifecycle gc failed:", error);
      }
    }

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

  private async syncTimers(): Promise<void> {
    const now = nowIso();
    const due = this.store.listDueTimers(now);
    for (const timer of due) {
      try {
        await this.fireTimer(timer, now);
      } catch (error) {
        console.warn(`timer fire failed for ${timer.scheduleId}:`, error);
      }
    }
    this.rescheduleTimerSync();
  }

  private refreshTimersOnStart(): void {
    const now = nowIso();
    for (const timer of this.store.listTimers()) {
      if (timer.status !== "active") {
        continue;
      }
      const nextFireAt = computeNextTimerFire({
        mode: timer.mode,
        at: timer.at ?? null,
        intervalMs: timer.intervalMs ?? null,
        cronExpr: timer.cronExpr ?? null,
        timezone: timer.timezone,
        fromIso: now,
        lastFiredAt: timer.lastFiredAt ?? null,
        restartRecovery: true,
      });
      this.store.updateTimer(timer.scheduleId, {
        nextFireAt,
        status: nextFireAt ? "active" : "paused",
        updatedAt: now,
      });
    }
  }

  private rescheduleTimerSync(): void {
    if (this.timerSyncTimeout) {
      clearTimeout(this.timerSyncTimeout);
      this.timerSyncTimeout = null;
    }
    if (this.stopping) {
      return;
    }
    const nearest = this.store.getNearestActiveTimer();
    if (!nearest?.nextFireAt) {
      return;
    }
    const dueAt = Date.parse(nearest.nextFireAt);
    if (Number.isNaN(dueAt)) {
      return;
    }
    const delay = Math.max(0, dueAt - Date.now());
    this.timerSyncTimeout = setTimeout(() => {
      this.timerSyncTimeout = null;
      void this.syncTimers();
    }, delay);
  }

  private refreshSourceIdleState(sourceId: string): void {
    const source = this.store.getSource(sourceId);
    if (!source) {
      this.store.deleteSourceIdleState(sourceId);
      return;
    }
    const sourceAdapter = this.adapters.sourceAdapterFor(source.sourceType);
    if (!sourceAdapter.pauseSource) {
      this.store.deleteSourceIdleState(sourceId);
      return;
    }
    if (source.status === "paused") {
      this.store.deleteSourceIdleState(sourceId);
      return;
    }
    const remainingSubscriptions = this.store.listSubscriptionsForSource(sourceId).length;
    if (remainingSubscriptions > 0) {
      this.store.deleteSourceIdleState(sourceId);
      return;
    }
    const now = nowIso();
    this.store.upsertSourceIdleState({
      sourceId,
      idleSince: now,
      autoPauseAt: new Date(Date.parse(now) + DEFAULT_IDLE_SOURCE_GRACE_MS).toISOString(),
      autoPausedAt: null,
      updatedAt: now,
    });
  }
}

function hasSubscriptionFieldOverride(input: RegisterSubscriptionInput): boolean {
  if (input.trackedResourceRef != null || input.cleanupPolicy != null) {
    return true;
  }
  return input.filter != null && Object.keys(input.filter).length > 0;
}

function buildPreviewSource(input: PreviewSourceSchemaInput): SourceStream {
  const sourceType = sourceTypeForPreviewRef(input.sourceRef);
  const now = nowIso();
  return {
    sourceId: "__preview__",
    sourceType,
    sourceKey: `preview:${input.sourceRef}`,
    configRef: input.configRef ?? null,
    config: input.config ?? {},
    status: "active",
    checkpoint: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sourceTypeForPreviewRef(sourceRef: string): SourceStream["sourceType"] {
  if (sourceRef === "local_event" || sourceRef === "remote_source" || sourceRef === "github_repo" || sourceRef === "github_repo_ci" || sourceRef === "feishu_bot") {
    return sourceRef;
  }
  if (sourceRef.startsWith("remote:")) {
    return "remote_source";
  }
  throw new Error(`unknown source kind or type for preview: ${sourceRef}`);
}

function normalizeTrackedResourceRef(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCleanupPolicy(input: CleanupPolicy | null): CleanupPolicy {
  if (!input) {
    return { mode: "manual" };
  }
  if (input.mode === "manual") {
    if ("at" in input || "gracePeriodSecs" in input) {
      throw new Error("cleanupPolicy mode manual does not allow at or gracePeriodSecs");
    }
    return { mode: "manual" };
  }
  if (input.mode === "at") {
    if (!isValidIsoTimestamp(input.at)) {
      throw new Error("cleanupPolicy mode at requires a valid ISO8601 at timestamp");
    }
    if ("gracePeriodSecs" in input) {
      throw new Error("cleanupPolicy mode at does not allow gracePeriodSecs");
    }
    return { mode: "at", at: canonicalIsoTimestamp(input.at) };
  }
  if (input.mode === "on_terminal") {
    if ("at" in input) {
      throw new Error("cleanupPolicy mode on_terminal does not allow at");
    }
    return {
      mode: "on_terminal",
      ...(input.gracePeriodSecs != null ? { gracePeriodSecs: normalizeGracePeriodSecs(input.gracePeriodSecs) } : {}),
    };
  }
  if (input.mode === "on_terminal_or_at") {
    if (!isValidIsoTimestamp(input.at)) {
      throw new Error("cleanupPolicy mode on_terminal_or_at requires a valid ISO8601 at timestamp");
    }
    return {
      mode: "on_terminal_or_at",
      at: canonicalIsoTimestamp(input.at),
      ...(input.gracePeriodSecs != null ? { gracePeriodSecs: normalizeGracePeriodSecs(input.gracePeriodSecs) } : {}),
    };
  }
  throw new Error(`unsupported cleanup policy mode: ${(input as { mode?: string }).mode ?? "unknown"}`);
}

function normalizeGracePeriodSecs(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("cleanupPolicy gracePeriodSecs must be a non-negative integer");
  }
  return value;
}

function normalizeLifecycleSignal(signal: LifecycleSignal, fallbackOccurredAt?: string): LifecycleSignal | null {
  const ref = typeof signal.ref === "string" ? signal.ref.trim() : "";
  if (ref.length === 0) {
    return null;
  }
  return {
    ref,
    terminal: signal.terminal,
    state: signal.state ?? null,
    result: signal.result ?? null,
    occurredAt: normalizeLifecycleOccurredAt(signal.occurredAt, fallbackOccurredAt),
  };
}

function normalizeLifecycleOccurredAt(value?: string, fallback?: string): string {
  if (value && isValidIsoTimestamp(value)) {
    return value;
  }
  if (fallback && isValidIsoTimestamp(fallback)) {
    return fallback;
  }
  return nowIso();
}

function lifecycleRetireAtForSignal(cleanupPolicy: CleanupPolicy, signalOccurredAtMs: number): string | null {
  if (cleanupPolicy.mode === "manual" || cleanupPolicy.mode === "at") {
    return null;
  }
  if (cleanupPolicy.mode === "on_terminal") {
    return lifecycleSignalRetireAt(signalOccurredAtMs, cleanupPolicy.gracePeriodSecs ?? null);
  }
  return minIsoTimestamps(
    cleanupPolicy.at,
    lifecycleSignalRetireAt(signalOccurredAtMs, cleanupPolicy.gracePeriodSecs ?? null),
  );
}

function lifecycleSignalRetireAt(signalOccurredAtMs: number, gracePeriodSecs: number | null): string {
  const graceMs = Math.max(0, gracePeriodSecs ?? 0) * 1000;
  return new Date(signalOccurredAtMs + graceMs).toISOString();
}

function lifecycleDeadlineAt(cleanupPolicy: CleanupPolicy): string | null {
  if (cleanupPolicy.mode === "at" || cleanupPolicy.mode === "on_terminal_or_at") {
    return cleanupPolicy.at;
  }
  return null;
}

function minIsoTimestamps(left: string, right: string): string {
  return new Date(Math.min(Date.parse(left), Date.parse(right))).toISOString();
}

function canonicalIsoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractional = match[8] ?? "";
  const timezone = match[9];
  const offsetSign = match[10];
  const offsetHour = match[11] != null ? Number(match[11]) : 0;
  const offsetMinute = match[12] != null ? Number(match[12]) : 0;
  const millisecond = fractional.length === 0 ? 0 : Number((fractional + "000").slice(0, 3));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const offsetMinutes = timezone === "Z"
    ? 0
    : (offsetSign === "+" ? 1 : -1) * ((offsetHour * 60) + offsetMinute);
  const expectedTime = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
    - (offsetMinutes * 60_000);

  return parsed.getTime() === expectedTime;
}

function retentionCutoffIso(retentionMs: number): string {
  return new Date(Date.now() - retentionMs).toISOString();
}

function resolveDeliveryHandle(
  request: DeliveryRequest | DeliveryActionsRequest | DeliveryInvokeRequest,
): DeliveryHandle {
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

function resolveDeliverySource(
  store: AgentInboxStore,
  sourceId: string | undefined,
  handle: DeliveryHandle,
): SourceStream | null {
  if (!sourceId) {
    return null;
  }
  const source = store.getSource(sourceId);
  if (!source) {
    throw new Error(`unknown source: ${sourceId}`);
  }
  const expectedProvider = providerForSourceType(source.sourceType);
  if (expectedProvider && expectedProvider !== handle.provider) {
    throw new Error(`source ${sourceId} does not match delivery provider ${handle.provider}`);
  }
  return source;
}

function providerForSourceType(sourceType: SourceStream["sourceType"]): string | null {
  if (sourceType === "github_repo") {
    return "github";
  }
  if (sourceType === "feishu_bot") {
    return "feishu";
  }
  return null;
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

function validateMinUnackedItems(value: number | null | undefined): void {
  if (value == null) {
    return;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("minUnackedItems must be a positive integer");
  }
}

function notificationPolicyForTarget(target: ActivationTarget): NotificationPolicy {
  return target.notificationPolicy ?? {
    notifyLeaseMs: target.notifyLeaseMs,
    minUnackedItems: target.minUnackedItems ?? null,
  };
}

function inboxAggregationPolicy(inbox: Inbox): Required<InboxAggregationPolicy> {
  return {
    enabled: inbox.aggregationEnabled ?? false,
    windowMs: inbox.aggregationWindowMs ?? DEFAULT_INBOX_AGGREGATION_WINDOW_MS,
    maxItems: inbox.aggregationMaxItems ?? DEFAULT_INBOX_AGGREGATION_MAX_ITEMS,
    maxThreadAgeMs: inbox.aggregationMaxThreadAgeMs ?? DEFAULT_INBOX_AGGREGATION_MAX_THREAD_AGE_MS,
  };
}

function meetsNotificationThreshold(policy: NotificationPolicy, totalUnackedCount: number): boolean {
  if (policy.minUnackedItems == null) {
    return true;
  }
  return totalUnackedCount >= policy.minUnackedItems;
}

function activationItemFromInboxItem(item: InboxItem): ActivationItem {
  return {
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
}

function digestGroupKey(sourceId: string, resourceRef: string, eventFamily: string): string {
  return `${sourceId}::${resourceRef}::${eventFamily}`;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function sameDeliveryHandle(left: DeliveryHandle | null | undefined, right: DeliveryHandle | null | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sharedDeliveryHandle(items: InboxItem[]): DeliveryHandle | null {
  const first = items[0]?.deliveryHandle ?? null;
  if (!first) {
    return null;
  }
  for (const item of items.slice(1)) {
    if (!sameDeliveryHandle(first, item.deliveryHandle ?? null)) {
      return null;
    }
  }
  return first;
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

function isSameTerminalIdentity(target: TerminalActivationTarget, input: RegisterAgentInput): boolean {
  if (input.runtimeSessionId && target.runtimeKind === (input.runtimeKind ?? "unknown") && target.runtimeSessionId === input.runtimeSessionId) {
    return true;
  }
  if (input.backend === "tmux" && input.tmuxPaneId && target.backend === "tmux" && target.tmuxPaneId === input.tmuxPaneId) {
    return true;
  }
  if (input.backend === "iterm2" && target.backend === "iterm2") {
    if (input.itermSessionId && target.itermSessionId === input.itermSessionId) {
      return true;
    }
    if (input.tty && target.tty === input.tty) {
      return true;
    }
  }
  return false;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function uniqueSortedNullable(values: Array<string | null | undefined>): string[] {
  return uniqueSorted(values.filter((value): value is string => typeof value === "string" && value.length > 0));
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

function latestSummary(entries: Array<{ summary: string | null }>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const summary = entries[index]?.summary;
    if (summary) {
      return summary;
    }
  }
  return null;
}

function terminalReminderFingerprint(prompt: string, items: InboxEntry[]): string {
  const payload = JSON.stringify({
    prompt,
    itemIds: items
      .map((item) => item.entryId)
      .sort((left, right) => left.localeCompare(right)),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function toActivationDispatchDeferReason(reason: string, logger?: Logger): ActivationDispatchDeferReason {
  if (reason === "terminal_recently_active" || reason === "terminal_busy") {
    return reason;
  }
  logger?.warn("activation.unexpected_defer_reason", {
    reason,
    fallback: reason,
  });
  return reason;
}

function terminalDeferRetryMs(attempts: number): number {
  const normalizedAttempts = Math.max(1, attempts);
  const multiplier = 2 ** (normalizedAttempts - 1);
  return Math.min(DEFAULT_NOTIFY_RETRY_MS * multiplier, MAX_TERMINAL_DEFER_RETRY_MS);
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

function summarizeDirectInboxMessage(sender: string | null): string {
  if (sender) {
    return `direct_text_message:${sender}`;
  }
  return "direct_text_message";
}

function summarizeTimerMessage(scheduleId: string): string {
  return `timer:${scheduleId}`;
}

function normalizeDirectInboxMessage(message: string): string {
  if (typeof message !== "string") {
    throw new Error("direct inbox message must be a string");
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new Error("direct inbox message must not be empty");
  }
  return trimmed;
}

function normalizeDirectInboxSender(sender: string | null | undefined): string | null {
  if (sender == null) {
    return null;
  }
  if (typeof sender !== "string") {
    throw new Error("direct inbox sender must be a string");
  }
  const trimmed = sender.trim();
  if (trimmed.length === 0) {
    throw new Error("direct inbox sender must not be empty");
  }
  return trimmed;
}

function normalizeTimerInput(input: RegisterTimerInput): {
  mode: "at" | "every" | "cron";
  at?: string | null;
  every?: number | null;
  cron?: string | null;
  timezone?: string | null;
} {
  const modes = [input.at != null, input.every != null, input.cron != null].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error("timers require exactly one of at, every, or cron");
  }
  if (input.at != null) {
    const at = normalizeIsoTimestamp(input.at, "timer at");
    return { mode: "at", at, timezone: input.timezone ?? null };
  }
  if (input.every != null) {
    if (!Number.isInteger(input.every) || input.every < MIN_TIMER_INTERVAL_MS) {
      throw new Error("timer every interval must be an integer number of milliseconds and at least 60000");
    }
    return { mode: "every", every: input.every, timezone: input.timezone ?? null };
  }
  const cron = normalizeCronExpression(input.cron!);
  return { mode: "cron", cron, timezone: input.timezone ?? null };
}

function normalizeIsoTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be a valid ISO8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeCronExpression(value: string): string {
  if (typeof value !== "string") {
    throw new Error("timer cron must be a string");
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    throw new Error("timer cron must use standard 5-field syntax");
  }
  for (const field of fields) {
    if (/[LW#@]/.test(field)) {
      throw new Error("timer cron does not support extensions like L, W, #, or @reboot");
    }
  }
  parseCronExpression(trimmed);
  return trimmed;
}

function detectHostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function assertValidTimeZone(timezone: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid timezone: ${timezone}`);
  }
}

function computeNextTimerFire(input: {
  mode: "at" | "every" | "cron";
  at: string | null;
  intervalMs: number | null;
  cronExpr: string | null;
  timezone: string;
  fromIso: string;
  lastFiredAt: string | null;
  restartRecovery: boolean;
}): string | null {
  const fromMs = Date.parse(input.fromIso);
  if (Number.isNaN(fromMs)) {
    return null;
  }
  if (input.mode === "at") {
    if (!input.at) {
      return null;
    }
    const atMs = Date.parse(input.at);
    if (Number.isNaN(atMs)) {
      return null;
    }
    if (input.lastFiredAt) {
      return null;
    }
    if (atMs <= fromMs) {
      return input.restartRecovery ? input.at : input.at;
    }
    return input.at;
  }
  if (input.mode === "every") {
    if (!input.intervalMs) {
      return null;
    }
    if (!input.lastFiredAt) {
      return new Date(fromMs + input.intervalMs).toISOString();
    }
    const lastFiredMs = Date.parse(input.lastFiredAt);
    if (Number.isNaN(lastFiredMs)) {
      return new Date(fromMs + input.intervalMs).toISOString();
    }
    const base = input.restartRecovery ? fromMs : Math.max(fromMs, lastFiredMs);
    return new Date(base + input.intervalMs).toISOString();
  }
  if (!input.cronExpr) {
    return null;
  }
  return nextCronOccurrence(input.cronExpr, input.timezone, new Date(fromMs));
}

type ParsedCronField = {
  any: boolean;
  values: Set<number>;
};

type ParsedCron = {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
};

function parseCronExpression(expr: string): ParsedCron {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.split(" ");
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, true),
  };
}

function parseCronField(field: string, min: number, max: number, normalizeSunday = false): ParsedCronField {
  if (field === "*") {
    return { any: true, values: new Set() };
  }
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron field: ${field}`);
    }
    const [startRaw, endRaw] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
    const start = Number(startRaw);
    const end = endRaw != null ? Number(endRaw) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`invalid cron field: ${field}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return { any: false, values };
}

function nextCronOccurrence(expr: string, timezone: string, after: Date): string | null {
  const parsed = parseCronExpression(expr);
  let candidate = addMinutes(after, 1);
  candidate.setUTCSeconds(0, 0);

  for (let guard = 0; guard < 10_000; guard += 1) {
    const zoned = zonedDateParts(candidate, timezone);

    const nextMonth = nextAllowedValue(parsed.month, zoned.month, 1, 12);
    if (nextMonth == null) {
      candidate = utcDateForZoned(timezone, zoned.year + 1, firstAllowedValue(parsed.month, 1, 12), 1, 0, 0);
      continue;
    }
    if (nextMonth !== zoned.month) {
      candidate = utcDateForZoned(timezone, zoned.year, nextMonth, 1, 0, 0);
      continue;
    }

    if (!matchesCronDay(parsed, zoned)) {
      candidate = utcDateForZoned(timezone, zoned.year, zoned.month, zoned.day + 1, 0, 0);
      continue;
    }

    const nextHour = nextAllowedValue(parsed.hour, zoned.hour, 0, 23);
    if (nextHour == null) {
      candidate = utcDateForZoned(timezone, zoned.year, zoned.month, zoned.day + 1, firstAllowedValue(parsed.hour, 0, 23), 0);
      continue;
    }
    if (nextHour !== zoned.hour) {
      candidate = utcDateForZoned(timezone, zoned.year, zoned.month, zoned.day, nextHour, 0);
      continue;
    }

    const nextMinute = nextAllowedValue(parsed.minute, zoned.minute, 0, 59);
    if (nextMinute == null) {
      candidate = utcDateForZoned(timezone, zoned.year, zoned.month, zoned.day, zoned.hour + 1, firstAllowedValue(parsed.minute, 0, 59));
      continue;
    }
    if (nextMinute !== zoned.minute) {
      candidate = utcDateForZoned(timezone, zoned.year, zoned.month, zoned.day, zoned.hour, nextMinute);
      continue;
    }

    if (matchesCron(parsed, zoned)) {
      return candidate.toISOString();
    }
    candidate = addMinutes(candidate, 1);
  }
  return null;
}

function matchesCron(parsed: ParsedCron, parts: ReturnType<typeof zonedDateParts>): boolean {
  const monthMatches = parsed.month.any || parsed.month.values.has(parts.month);
  const hourMatches = parsed.hour.any || parsed.hour.values.has(parts.hour);
  const minuteMatches = parsed.minute.any || parsed.minute.values.has(parts.minute);
  if (!monthMatches || !hourMatches || !minuteMatches) {
    return false;
  }
  const dayOfMonthMatches = parsed.dayOfMonth.any || parsed.dayOfMonth.values.has(parts.day);
  const dayOfWeekMatches = parsed.dayOfWeek.any || parsed.dayOfWeek.values.has(parts.dayOfWeek);
  if (!parsed.dayOfMonth.any && !parsed.dayOfWeek.any) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function matchesCronDay(parsed: ParsedCron, parts: ReturnType<typeof zonedDateParts>): boolean {
  const dayOfMonthMatches = parsed.dayOfMonth.any || parsed.dayOfMonth.values.has(parts.day);
  const dayOfWeekMatches = parsed.dayOfWeek.any || parsed.dayOfWeek.values.has(parts.dayOfWeek);
  if (!parsed.dayOfMonth.any && !parsed.dayOfWeek.any) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function zonedDateParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const entries = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const hour = Number(entries.hour);
  return {
    year: Number(entries.year),
    month: Number(entries.month),
    day: Number(entries.day),
    // Some ICU builds format midnight as 24:00 even for exact timestamps.
    // Normalize that representation so cron matching stays cross-platform.
    hour: hour === 24 ? 0 : hour,
    minute: Number(entries.minute),
    dayOfWeek: weekdayToNumber(entries.weekday),
  };
}

function nextAllowedValue(field: ParsedCronField, current: number, min: number, max: number): number | null {
  if (field.any) {
    return current;
  }
  for (let value = current; value <= max; value += 1) {
    if (field.values.has(value)) {
      return value;
    }
  }
  return null;
}

function firstAllowedValue(field: ParsedCronField, min: number, max: number): number {
  if (field.any) {
    return min;
  }
  for (let value = min; value <= max; value += 1) {
    if (field.values.has(value)) {
      return value;
    }
  }
  return min;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function utcDateForZoned(timezone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const approx = new Date(approxUtc);
  const zoned = zonedDateParts(approx, timezone);
  const targetNaiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const zonedNaiveUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0, 0);
  return new Date(approxUtc - (zonedNaiveUtc - targetNaiveUtc));
}

function weekdayToNumber(value: string): number {
  switch (value) {
    case "Sun": return 0;
    case "Mon": return 1;
    case "Tue": return 2;
    case "Wed": return 3;
    case "Thu": return 4;
    case "Fri": return 5;
    case "Sat": return 6;
    default:
      throw new Error(`unsupported weekday: ${value}`);
  }
}

function listHostStreamKinds(hostType: SourceHost["hostType"]): string[] {
  switch (hostType) {
    case "github":
      return ["repo_events", "ci_runs"];
    case "feishu":
      return ["message_events"];
    case "local_event":
      return ["events"];
    case "remote_source":
      return ["default"];
  }
}

function getHostConfigFields(hostType: SourceHost["hostType"]): Array<{ name: string; type: string; description: string; required?: boolean }> {
  switch (hostType) {
    case "github":
      return [
        { name: "uxcAuth", type: "string", description: "Optional shared GitHub auth/runtime profile.", required: false },
      ];
    case "feishu":
      return [
        { name: "appId", type: "string", description: "Feishu app ID.", required: true },
        { name: "appSecret", type: "string", description: "Feishu app secret.", required: true },
        { name: "uxcAuth", type: "string", description: "Optional shared Feishu auth/runtime profile.", required: false },
      ];
    case "local_event":
      return [];
    case "remote_source":
      return [];
  }
}

function sourceTypeForStreamRegistration(hostType: SourceHost["hostType"], streamKind: string): SourceStream["sourceType"] {
  if (hostType === "github") {
    if (streamKind === "ci_runs") {
      return "github_repo_ci";
    }
    return "github_repo";
  }
  if (hostType === "feishu") {
    return "feishu_bot";
  }
  if (hostType === "local_event") {
    return "local_event";
  }
  return "remote_source";
}
