import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable("sources", {
  sourceId: text("source_id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceKey: text("source_key").notNull(),
  configRef: text("config_ref"),
  configJson: text("config_json").notNull(),
  status: text("status").notNull(),
  checkpoint: text("checkpoint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  sourceTypeKey: uniqueIndex("idx_sources_type_key").on(table.sourceType, table.sourceKey),
}));

export const agents = sqliteTable("agents", {
  agentId: text("agent_id").primaryKey(),
  status: text("status").notNull(),
  offlineSince: text("offline_since"),
  runtimeKind: text("runtime_kind").notNull(),
  runtimeSessionId: text("runtime_session_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

export const inboxes = sqliteTable("inboxes", {
  inboxId: text("inbox_id").primaryKey(),
  ownerAgentId: text("owner_agent_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  subscriptionId: text("subscription_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  sourceId: text("source_id").notNull(),
  filterJson: text("filter_json").notNull(),
  lifecycleMode: text("lifecycle_mode").notNull(),
  expiresAt: text("expires_at"),
  startPolicy: text("start_policy").notNull(),
  startOffset: integer("start_offset"),
  startTime: text("start_time"),
  createdAt: text("created_at").notNull(),
});

export const activationTargets = sqliteTable("activation_targets", {
  targetId: text("target_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  offlineSince: text("offline_since"),
  consecutiveFailures: integer("consecutive_failures").notNull(),
  lastDeliveredAt: text("last_delivered_at"),
  lastError: text("last_error"),
  mode: text("mode").notNull(),
  notifyLeaseMs: integer("notify_lease_ms").notNull(),
  url: text("url"),
  runtimeKind: text("runtime_kind"),
  runtimeSessionId: text("runtime_session_id"),
  backend: text("backend"),
  tmuxPaneId: text("tmux_pane_id"),
  tty: text("tty"),
  termProgram: text("term_program"),
  itermSessionId: text("iterm_session_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

export const activationDispatchStates = sqliteTable("activation_dispatch_states", {
  agentId: text("agent_id").notNull(),
  targetId: text("target_id").notNull(),
  status: text("status").notNull(),
  leaseExpiresAt: text("lease_expires_at"),
  pendingNewItemCount: integer("pending_new_item_count").notNull(),
  pendingSummary: text("pending_summary"),
  pendingSubscriptionIdsJson: text("pending_subscription_ids_json").notNull(),
  pendingSourceIdsJson: text("pending_source_ids_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const inboxItems = sqliteTable("inbox_items", {
  itemId: text("item_id").primaryKey(),
  sourceId: text("source_id").notNull(),
  sourceNativeId: text("source_native_id").notNull(),
  eventVariant: text("event_variant").notNull(),
  inboxId: text("inbox_id").notNull(),
  occurredAt: text("occurred_at").notNull(),
  metadataJson: text("metadata_json").notNull(),
  rawPayloadJson: text("raw_payload_json").notNull(),
  deliveryHandleJson: text("delivery_handle_json"),
  ackedAt: text("acked_at"),
});

export const activations = sqliteTable("activations", {
  activationId: text("activation_id").primaryKey(),
  kind: text("kind").notNull(),
  agentId: text("agent_id").notNull(),
  inboxId: text("inbox_id").notNull(),
  targetId: text("target_id").notNull(),
  targetKind: text("target_kind").notNull(),
  subscriptionIdsJson: text("subscription_ids_json").notNull(),
  sourceIdsJson: text("source_ids_json").notNull(),
  newItemCount: integer("new_item_count").notNull(),
  summary: text("summary").notNull(),
  itemsJson: text("items_json"),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at"),
});

export const deliveries = sqliteTable("deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  provider: text("provider").notNull(),
  surface: text("surface").notNull(),
  targetRef: text("target_ref").notNull(),
  threadRef: text("thread_ref"),
  replyMode: text("reply_mode"),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const streams = sqliteTable("streams", {
  streamId: text("stream_id").primaryKey(),
  sourceId: text("source_id").notNull(),
  streamKey: text("stream_key").notNull(),
  backend: text("backend").notNull(),
  createdAt: text("created_at").notNull(),
});

export const streamEvents = sqliteTable("stream_events", {
  offset: integer("offset").primaryKey({ autoIncrement: true }),
  streamEventId: text("stream_event_id").notNull(),
  streamId: text("stream_id").notNull(),
  sourceId: text("source_id").notNull(),
  sourceNativeId: text("source_native_id").notNull(),
  eventVariant: text("event_variant").notNull(),
  occurredAt: text("occurred_at").notNull(),
  metadataJson: text("metadata_json").notNull(),
  rawPayloadJson: text("raw_payload_json").notNull(),
  deliveryHandleJson: text("delivery_handle_json"),
  createdAt: text("created_at").notNull(),
});

export const consumers = sqliteTable("consumers", {
  consumerId: text("consumer_id").primaryKey(),
  streamId: text("stream_id").notNull(),
  subscriptionId: text("subscription_id").notNull(),
  consumerKey: text("consumer_key").notNull(),
  startPolicy: text("start_policy").notNull(),
  startOffset: integer("start_offset"),
  startTime: text("start_time"),
  nextOffset: integer("next_offset").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const consumerCommits = sqliteTable("consumer_commits", {
  commitId: text("commit_id").primaryKey(),
  consumerId: text("consumer_id").notNull(),
  streamId: text("stream_id").notNull(),
  committedOffset: integer("committed_offset").notNull(),
  committedAt: text("committed_at").notNull(),
});

