export type SourceType = "fixture" | "github_repo" | "feishu_bot";

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

export interface Interest {
  interestId: string;
  agentId: string;
  sourceId: string;
  mailboxId: string;
  matchRules: Record<string, unknown>;
  activationTarget?: string | null;
  createdAt: string;
}

export interface InboxItem {
  itemId: string;
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  mailboxId: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  deliveryHandle?: DeliveryHandle | null;
  ackedAt?: string | null;
}

export interface Activation {
  activationId: string;
  agentId: string;
  mailboxId: string;
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

export interface RegisterInterestInput {
  agentId: string;
  sourceId: string;
  mailboxId?: string;
  matchRules?: Record<string, unknown>;
  activationTarget?: string | null;
}

export interface EmitItemInput {
  sourceId: string;
  sourceNativeId: string;
  eventVariant: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  deliveryHandle?: DeliveryHandle | null;
}

export interface DeliveryRequest {
  mailboxId?: string;
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
