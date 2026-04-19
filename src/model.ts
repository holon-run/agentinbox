export type SourceType = "local_event" | "remote_source" | "github_repo" | "github_repo_ci" | "feishu_bot";
export type HostType = "local_event" | "remote_source" | "github" | "feishu";

export type SubscriptionStartPolicy = "latest" | "earliest" | "at_offset" | "at_time";
export type ActivationMode = "activation_only" | "activation_with_items";
export type TerminalBackend = "tmux" | "iterm2";
export type TerminalMode = "agent_prompt";
export type RuntimeKind = "codex" | "claude_code" | "unknown";
export type ActivationTargetKind = "webhook" | "terminal";
export type ActivationDispatchStatus = "notified" | "dirty";
export type AgentStatus = "active" | "offline";
export type ActivationTargetStatus = "active" | "offline";

export interface DeliveryHandle {
  provider: string;
  surface: string;
  targetRef: string;
  threadRef?: string | null;
  replyMode?: string | null;
}

export interface SourceHost {
  hostId: string;
  hostType: HostType;
  hostKey: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
  status: "active" | "paused" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface SourceStream {
  sourceId: string;
  streamId?: string | null;
  hostId?: string;
  streamKind?: string;
  streamKey?: string;
  sourceType: SourceType;
  sourceKey: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
  status: "active" | "paused" | "error";
  checkpoint?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRuntimeState {
  backend: "uxc";
  observation: "live" | "cached";
  namespace: string;
  sourceKey: string;
  status?: string | null;
  runId?: string | null;
  streamId?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

export interface SourceIdleState {
  sourceId: string;
  idleSince: string;
  autoPauseAt: string;
  autoPausedAt?: string | null;
  updatedAt: string;
}

export interface SubscriptionFilter {
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  expr?: string;
}

export type CleanupPolicy =
  | { mode: "manual" }
  | { mode: "at"; at: string }
  | { mode: "on_terminal"; gracePeriodSecs?: number | null }
  | { mode: "on_terminal_or_at"; at: string; gracePeriodSecs?: number | null };

export interface Agent {
  agentId: string;
  status: AgentStatus;
  offlineSince?: string | null;
  runtimeKind: RuntimeKind;
  runtimeSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface Inbox {
  inboxId: string;
  ownerAgentId: string;
  aggregationEnabled?: boolean;
  aggregationWindowMs?: number | null;
  aggregationMaxItems?: number | null;
  aggregationMaxThreadAgeMs?: number | null;
  createdAt: string;
}

export interface Subscription {
  subscriptionId: string;
  agentId: string;
  sourceId: string;
  filter: SubscriptionFilter;
  trackedResourceRef?: string | null;
  cleanupPolicy: CleanupPolicy;
  startPolicy: SubscriptionStartPolicy;
  startOffset?: number | null;
  startTime?: string | null;
  createdAt: string;
}

export interface SubscriptionLifecycleRetirement {
  subscriptionId: string;
  hostId: string;
  trackedResourceRef: string;
  retireAt: string;
  terminalState?: string | null;
  terminalResult?: string | null;
  terminalOccurredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPolicy {
  notifyLeaseMs: number;
  minUnackedItems?: number | null;
}

export interface InboxAggregationPolicy {
  enabled?: boolean;
  windowMs?: number | null;
  maxItems?: number | null;
  maxThreadAgeMs?: number | null;
}

interface ActivationTargetBase {
  targetId: string;
  agentId: string;
  kind: ActivationTargetKind;
  status: ActivationTargetStatus;
  offlineSince?: string | null;
  consecutiveFailures: number;
  lastDeliveredAt?: string | null;
  lastError?: string | null;
  notifyLeaseMs: number;
  minUnackedItems?: number | null;
  notificationPolicy?: NotificationPolicy;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface WebhookActivationTarget extends ActivationTargetBase {
  kind: "webhook";
  mode: ActivationMode;
  url: string;
}

export interface TerminalActivationTarget extends ActivationTargetBase {
  kind: "terminal";
  mode: TerminalMode;
  runtimeKind: RuntimeKind;
  runtimeSessionId?: string | null;
  runtimePid?: number | null;
  backend: TerminalBackend;
  tmuxPaneId?: string | null;
  tty?: string | null;
  termProgram?: string | null;
  itermSessionId?: string | null;
}

export type ActivationTarget = WebhookActivationTarget | TerminalActivationTarget;

export type ActivationDispatchDeferReason = string;

export interface ActivationDispatchState {
  agentId: string;
  targetId: string;
  status: ActivationDispatchStatus;
  leaseExpiresAt: string | null;
  lastNotifiedFingerprint: string | null;
  deferReason: ActivationDispatchDeferReason | null;
  deferAttempts: number;
  firstDeferredAt: string | null;
  lastDeferredAt: string | null;
  pendingFingerprint: string | null;
  pendingNewItemCount: number;
  pendingSummary: string | null;
  pendingSubscriptionIds: string[];
  pendingSourceIds: string[];
  updatedAt: string;
}

export interface InboxItem {
  itemId: string;
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  inboxId: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  deliveryHandle?: DeliveryHandle | null;
  ackedAt?: string | null;
}

export interface ActivationItem {
  itemId: string;
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  inboxId: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  deliveryHandle?: DeliveryHandle | null;
}

export type InboxEntryKind = "item" | "digest_snapshot";

interface InboxEntryBase {
  entryId: string;
  inboxId: string;
  kind: InboxEntryKind;
  sequence: number;
  itemId: string;
  sourceId?: string;
  sourceNativeId?: string;
  eventVariant?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  summary: string;
  count: number;
  itemIds: string[];
  sourceIds: string[];
  subscriptionIds: string[];
  firstItemAt: string;
  lastItemAt: string;
  deliveryHandle?: DeliveryHandle | null;
  ackedAt?: string | null;
  supersededAt?: string | null;
}

export interface InboxItemEntry extends InboxEntryBase {
  kind: "item";
  item: ActivationItem;
}

export interface DigestSnapshotEntry extends InboxEntryBase {
  kind: "digest_snapshot";
  threadId: string;
  revision: number;
  groupKey: string;
  resourceRef?: string | null;
  eventFamily?: string | null;
}

export type InboxEntry = InboxItemEntry | DigestSnapshotEntry;

export interface NotificationGrouping {
  groupable: boolean;
  resourceRef?: string | null;
  eventFamily?: string | null;
  summaryHint?: string | null;
  flushClass?: "normal" | "immediate";
}

export interface Activation {
  kind: "agentinbox.activation";
  activationId: string;
  agentId: string;
  inboxId: string;
  targetId: string;
  targetKind: ActivationTargetKind;
  subscriptionIds: string[];
  sourceIds: string[];
  newEntryCount: number;
  newItemCount: number;
  summary: string;
  items?: ActivationItem[];
  entries?: InboxEntry[];
  createdAt: string;
  deliveredAt?: string | null;
}

export interface DeliveryAttempt {
  deliveryId: string;
  provider: string;
  surface: string;
  targetRef: string;
  threadRef?: string | null;
  replyMode?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: "accepted" | "sent" | "failed";
  createdAt: string;
}

export interface RegisterSourceInput {
  sourceType: SourceType;
  sourceKey: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface RegisterHostInput {
  hostType: HostType;
  hostKey: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface UpdateHostInput {
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface RegisterStreamInput {
  hostId: string;
  streamKind: string;
  streamKey: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface UpdateStreamInput {
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface UpdateSourceInput {
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface RegisterAgentInput {
  agentId?: string | null;
  forceRebind?: boolean;
  runtimeKind?: RuntimeKind | null;
  runtimeSessionId?: string | null;
  runtimePid?: number | null;
  backend: TerminalBackend;
  mode?: TerminalMode;
  tmuxPaneId?: string | null;
  tty?: string | null;
  termProgram?: string | null;
  itermSessionId?: string | null;
  notifyLeaseMs?: number | null;
  minUnackedItems?: number | null;
}

export interface RegisterAgentResult {
  agent: Agent;
  terminalTarget: TerminalActivationTarget;
  inbox: Inbox;
}

export interface AddWebhookActivationTargetInput {
  url: string;
  activationMode?: ActivationMode;
  notifyLeaseMs?: number | null;
  minUnackedItems?: number | null;
}

export interface DirectInboxTextMessageInput {
  message: string;
  sender?: string | null;
}

export interface DirectInboxTextMessageResult {
  itemId: string;
  inboxId: string;
  activated: boolean;
}

export type TimerMode = "at" | "every" | "cron";
export type TimerStatus = "active" | "paused";

export interface AgentTimer {
  scheduleId: string;
  agentId: string;
  status: TimerStatus;
  mode: TimerMode;
  at?: string | null;
  intervalMs?: number | null;
  cronExpr?: string | null;
  timezone: string;
  message: string;
  sender?: string | null;
  nextFireAt?: string | null;
  lastFiredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterTimerInput {
  agentId: string;
  at?: string | null;
  every?: number | null;
  cron?: string | null;
  timezone?: string | null;
  message: string;
  sender?: string | null;
}

export interface UpdateTimerStatusResult {
  updated: boolean;
  timer: AgentTimer;
}

export interface RegisterSubscriptionInput {
  agentId: string;
  sourceId: string;
  shortcut?: {
    name: string;
    args?: Record<string, unknown>;
  };
  filter?: SubscriptionFilter;
  trackedResourceRef?: string | null;
  cleanupPolicy?: CleanupPolicy | null;
  startPolicy?: SubscriptionStartPolicy;
  startOffset?: number | null;
  startTime?: string | null;
}

export interface PreviewSourceSchemaInput {
  sourceRef: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
}

export interface SourceSchemaField {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

export interface SourceSchema {
  sourceType: SourceType;
  metadataFields: SourceSchemaField[];
  payloadExamples: Record<string, unknown>[];
  eventVariantExamples: string[];
  configFields: SourceSchemaField[];
}

export interface ResolvedSourceIdentity {
  hostType: "local_event" | "remote_source";
  sourceKind: string;
  implementationId: string;
}

export interface ResolvedSourceSchema extends SourceSchema, ResolvedSourceIdentity {
  sourceId: string;
  aliases?: string[];
  subscriptionSchema?: {
    supportsTrackedResourceRef: boolean;
    supportsLifecycleSignals: boolean;
    shortcuts: Array<{
      name: string;
      description: string;
      argsSchema?: SourceSchemaField[];
    }>;
  };
}

export interface SourceSchemaPreview extends Omit<ResolvedSourceSchema, "sourceId"> {}

export interface AppendSourceEventInput {
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  deliveryHandle?: DeliveryHandle | null;
}

export interface AppendSourceEventResult {
  appended: number;
  deduped: number;
  lastOffset: number | null;
}

export interface DeliveryRequest {
  agentId?: string;
  sourceId?: string;
  deliveryHandle?: DeliveryHandle | null;
  provider?: string;
  surface?: string;
  targetRef?: string;
  threadRef?: string | null;
  replyMode?: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface DeliveryOperationDescriptor {
  name: string;
  title: string;
  inputSchema: Record<string, unknown>;
  canonicalTextAlias?: boolean;
}

export interface DeliveryActionsRequest {
  sourceId?: string;
  deliveryHandle?: DeliveryHandle | null;
  provider?: string;
  surface?: string;
  targetRef?: string;
  threadRef?: string | null;
  replyMode?: string | null;
}

export interface DeliveryInvokeRequest {
  sourceId?: string;
  deliveryHandle?: DeliveryHandle | null;
  provider?: string;
  surface?: string;
  targetRef?: string;
  threadRef?: string | null;
  replyMode?: string | null;
  operation: string;
  input: Record<string, unknown>;
}

export interface MatchResult {
  matched: boolean;
  reason: string;
}

export interface SourcePollResult {
  sourceId: string;
  sourceType: SourceType;
  appended: number;
  deduped: number;
  eventsRead: number;
  note: string;
}

export interface SubscriptionPollResult {
  subscriptionId: string;
  sourceId: string;
  eventsRead: number;
  matched: number;
  inboxItemsCreated: number;
  committedOffset: number | null;
  note: string;
}

export interface ListInboxItemsOptions {
  afterEntryId?: string;
  includeAcked?: boolean;
}

export interface WatchInboxOptions extends ListInboxItemsOptions {
  heartbeatMs?: number;
}

export interface InboxWatchItemsEvent {
  event: "items";
  agentId: string;
  entries: InboxEntry[];
}

export interface InboxWatchHeartbeatEvent {
  event: "heartbeat";
  agentId: string;
  timestamp: string;
}

export type InboxWatchEvent = InboxWatchItemsEvent | InboxWatchHeartbeatEvent;
