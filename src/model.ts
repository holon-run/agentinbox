export type SourceType = "fixture" | "github_repo" | "feishu_bot";

export type SubscriptionStartPolicy = "latest" | "earliest" | "at_offset" | "at_time";

export interface DeliveryHandle {
  provider: string;
  surface: string;
  targetRef: string;
  threadRef?: string | null;
  replyMode?: string | null;
}

export interface SubscriptionSource {
  sourceId: string;
  sourceType: SourceType;
  sourceKey: string;
  configRef?: string | null;
  config?: Record<string, unknown>;
  status: "active" | "paused" | "error";
  checkpoint?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Inbox {
  inboxId: string;
  ownerAgentId: string;
  createdAt: string;
}

export interface Subscription {
  subscriptionId: string;
  agentId: string;
  sourceId: string;
  inboxId: string;
  matchRules: Record<string, unknown>;
  activationTarget?: string | null;
  startPolicy: SubscriptionStartPolicy;
  startOffset?: number | null;
  startTime?: string | null;
  createdAt: string;
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

export interface Activation {
  activationId: string;
  agentId: string;
  inboxId: string;
  newItemCount: number;
  summary: string;
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

export interface RegisterSubscriptionInput {
  agentId: string;
  sourceId: string;
  inboxId?: string;
  matchRules?: Record<string, unknown>;
  activationTarget?: string | null;
  startPolicy?: SubscriptionStartPolicy;
  startOffset?: number | null;
  startTime?: string | null;
}

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
  inboxId?: string;
  deliveryHandle?: DeliveryHandle | null;
  provider?: string;
  surface?: string;
  targetRef?: string;
  threadRef?: string | null;
  replyMode?: string | null;
  kind: string;
  payload: Record<string, unknown>;
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
