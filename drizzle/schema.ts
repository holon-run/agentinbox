import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sourceHosts = sqliteTable("source_hosts", {
  hostId: text("host_id").primaryKey(),
  hostType: text("host_type").notNull(),
  hostKey: text("host_key").notNull(),
  configRef: text("config_ref"),
  configJson: text("config_json").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  hostTypeKey: uniqueIndex("idx_source_hosts_type_key").on(table.hostType, table.hostKey),
}));

export const sources = sqliteTable("sources", {
  sourceId: text("source_id").primaryKey(),
  hostId: text("host_id").notNull(),
  streamKind: text("stream_kind").notNull(),
  streamKey: text("stream_key").notNull(),
  sourceType: text("source_type").notNull(),
  sourceKey: text("source_key").notNull(),
  configRef: text("config_ref"),
  configJson: text("config_json").notNull(),
  status: text("status").notNull(),
  checkpoint: text("checkpoint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  sourceTypeKey: index("idx_sources_type_key").on(table.sourceType, table.sourceKey),
  hostStreamKey: uniqueIndex("idx_sources_host_stream_key").on(table.hostId, table.streamKind, table.streamKey),
}));

export const sourceIdleStates = sqliteTable("source_idle_states", {
  sourceId: text("source_id").primaryKey(),
  idleSince: text("idle_since").notNull(),
  autoPauseAt: text("auto_pause_at").notNull(),
  autoPausedAt: text("auto_paused_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  autoPauseAtIdx: index("idx_source_idle_states_auto_pause_at").on(table.autoPauseAt),
}));

export const timers = sqliteTable("timers", {
  scheduleId: text("schedule_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  status: text("status").notNull(),
  mode: text("mode").notNull(),
  at: text("at"),
  intervalMs: integer("interval_ms"),
  cronExpr: text("cron_expr"),
  timezone: text("timezone").notNull(),
  message: text("message").notNull(),
  sender: text("sender"),
  nextFireAt: text("next_fire_at"),
  lastFiredAt: text("last_fired_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  agentNextFireIdx: index("idx_timers_agent_next_fire_at").on(table.agentId, table.nextFireAt),
  nextFireIdx: index("idx_timers_next_fire_at").on(table.nextFireAt),
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
}, (table) => ({
  statusOfflineIdx: index("idx_agents_status_offline").on(table.status, table.offlineSince),
}));

export const inboxes = sqliteTable("inboxes", {
  inboxId: text("inbox_id").primaryKey(),
  ownerAgentId: text("owner_agent_id").notNull(),
  aggregationEnabled: integer("aggregation_enabled").notNull().default(0),
  aggregationWindowMs: integer("aggregation_window_ms"),
  aggregationMaxItems: integer("aggregation_max_items"),
  aggregationMaxThreadAgeMs: integer("aggregation_max_thread_age_ms"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  ownerAgentIdUnique: uniqueIndex("idx_inboxes_owner_agent_id").on(table.ownerAgentId),
}));

export const subscriptions = sqliteTable("subscriptions", {
  subscriptionId: text("subscription_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  sourceId: text("source_id").notNull(),
  filterJson: text("filter_json").notNull(),
  trackedResourceRef: text("tracked_resource_ref"),
  cleanupPolicyJson: text("cleanup_policy_json").notNull(),
  startPolicy: text("start_policy").notNull(),
  startOffset: integer("start_offset"),
  startTime: text("start_time"),
  createdAt: text("created_at").notNull(),
});

export const subscriptionLifecycleRetirements = sqliteTable("subscription_lifecycle_retirements", {
  subscriptionId: text("subscription_id").primaryKey(),
  hostId: text("host_id").notNull(),
  trackedResourceRef: text("tracked_resource_ref").notNull(),
  retireAt: text("retire_at").notNull(),
  terminalState: text("terminal_state"),
  terminalResult: text("terminal_result"),
  terminalOccurredAt: text("terminal_occurred_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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
  minUnackedItems: integer("min_unacked_items"),
  url: text("url"),
  runtimeKind: text("runtime_kind"),
  runtimeSessionId: text("runtime_session_id"),
  runtimePid: integer("runtime_pid"),
  backend: text("backend"),
  tmuxPaneId: text("tmux_pane_id"),
  tty: text("tty"),
  termProgram: text("term_program"),
  itermSessionId: text("iterm_session_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => ({
  agentStatusIdx: index("idx_activation_targets_agent_status").on(table.agentId, table.status),
}));

export const activationDispatchStates = sqliteTable("activation_dispatch_states", {
  agentId: text("agent_id").notNull(),
  targetId: text("target_id").notNull(),
  status: text("status").notNull(),
  leaseExpiresAt: text("lease_expires_at"),
  lastNotifiedFingerprint: text("last_notified_fingerprint"),
  deferReason: text("defer_reason"),
  deferAttempts: integer("defer_attempts").notNull().default(0),
  firstDeferredAt: text("first_deferred_at"),
  lastDeferredAt: text("last_deferred_at"),
  pendingFingerprint: text("pending_fingerprint"),
  pendingNewItemCount: integer("pending_new_item_count").notNull(),
  pendingSummary: text("pending_summary"),
  pendingSubscriptionIdsJson: text("pending_subscription_ids_json").notNull(),
  pendingSourceIdsJson: text("pending_source_ids_json").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentId, table.targetId] }),
  targetLeaseIdx: index("idx_activation_dispatch_states_target").on(table.targetId, table.leaseExpiresAt),
}));

export const inboxItems = sqliteTable("inbox_items", {
  itemId: text("item_id").primaryKey(),
  sourceId: text("source_id").notNull(),
  sourceNativeId: text("source_native_id").notNull(),
  eventVariant: text("event_variant").notNull(),
  inboxId: text("inbox_id").notNull(),
  inboxSequence: integer("inbox_sequence"),
  occurredAt: text("occurred_at").notNull(),
  metadataJson: text("metadata_json").notNull(),
  rawPayloadJson: text("raw_payload_json").notNull(),
  deliveryHandleJson: text("delivery_handle_json"),
  ackedAt: text("acked_at"),
}, (table) => ({
  sourceNativeEventInboxUnique: uniqueIndex("idx_inbox_items_source_native_event_inbox")
    .on(table.sourceId, table.sourceNativeId, table.eventVariant, table.inboxId),
  inboxSequenceUnique: uniqueIndex("idx_inbox_items_inbox_sequence").on(table.inboxSequence),
  ackedAtIdx: index("idx_inbox_items_acked_at").on(table.ackedAt),
  inboxAckedAtIdx: index("idx_inbox_items_inbox_acked_at").on(table.inboxId, table.ackedAt),
  inboxSequenceIdx: index("idx_inbox_items_inbox_sequence_order").on(table.inboxId, table.inboxSequence),
  sourceOccurredAtIdx: index("idx_inbox_items_source_occurred_at").on(table.sourceId, table.occurredAt),
}));

export const digestThreads = sqliteTable("digest_threads", {
  threadId: text("thread_id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  sourceId: text("source_id").notNull(),
  groupKey: text("group_key").notNull(),
  resourceRef: text("resource_ref"),
  eventFamily: text("event_family"),
  latestRevision: integer("latest_revision").notNull(),
  latestEntryId: text("latest_entry_id"),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  firstItemAt: text("first_item_at").notNull(),
  lastItemAt: text("last_item_at").notNull(),
  flushAfterAt: text("flush_after_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  inboxStatusIdx: index("idx_digest_threads_inbox_status").on(table.inboxId, table.status),
  groupStatusIdx: index("idx_digest_threads_group_status").on(table.inboxId, table.groupKey, table.status),
  flushIdx: index("idx_digest_threads_flush_after").on(table.status, table.flushAfterAt),
}));

export const inboxEntries = sqliteTable("inbox_entries", {
  entryId: text("entry_id").primaryKey(),
  inboxId: text("inbox_id").notNull(),
  kind: text("kind").notNull(),
  sequence: integer("sequence").notNull(),
  threadId: text("thread_id"),
  revision: integer("revision"),
  groupKey: text("group_key"),
  resourceRef: text("resource_ref"),
  eventFamily: text("event_family"),
  itemJson: text("item_json"),
  count: integer("count").notNull(),
  summary: text("summary").notNull(),
  firstItemAt: text("first_item_at").notNull(),
  lastItemAt: text("last_item_at").notNull(),
  sourceIdsJson: text("source_ids_json").notNull(),
  subscriptionIdsJson: text("subscription_ids_json").notNull(),
  deliveryHandleJson: text("delivery_handle_json"),
  ackedAt: text("acked_at"),
  supersededAt: text("superseded_at"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  sequenceUnique: uniqueIndex("idx_inbox_entries_sequence").on(table.sequence),
  inboxVisibleIdx: index("idx_inbox_entries_inbox_visible").on(table.inboxId, table.ackedAt, table.supersededAt, table.sequence),
  threadRevisionIdx: index("idx_inbox_entries_thread_revision").on(table.threadId, table.revision),
}));

export const inboxEntryItems = sqliteTable("inbox_entry_items", {
  entryId: text("entry_id").notNull(),
  itemId: text("item_id").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.entryId, table.itemId] }),
  itemIdx: index("idx_inbox_entry_items_item").on(table.itemId),
}));

export const digestThreadItems = sqliteTable("digest_thread_items", {
  threadId: text("thread_id").notNull(),
  itemId: text("item_id").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.threadId, table.itemId] }),
  itemIdx: index("idx_digest_thread_items_item").on(table.itemId),
}));

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
}, (table) => ({
  sourceIdUnique: uniqueIndex("idx_streams_source_id").on(table.sourceId),
  streamKeyUnique: uniqueIndex("idx_streams_stream_key").on(table.streamKey),
}));

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
}, (table) => ({
  streamEventIdUnique: uniqueIndex("idx_stream_events_stream_event_id").on(table.streamEventId),
  streamSourceNativeVariantUnique: uniqueIndex("idx_stream_events_stream_source_native_variant")
    .on(table.streamId, table.sourceNativeId, table.eventVariant),
  streamOffsetIdx: index("idx_stream_events_stream_offset").on(table.streamId, table.offset),
  streamOccurredAtIdx: index("idx_stream_events_stream_occurred_at").on(table.streamId, table.occurredAt),
}));

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
}, (table) => ({
  subscriptionIdUnique: uniqueIndex("idx_consumers_subscription_id").on(table.subscriptionId),
  consumerKeyUnique: uniqueIndex("idx_consumers_consumer_key").on(table.consumerKey),
  streamIdx: index("idx_consumers_stream").on(table.streamId),
}));

export const consumerCommits = sqliteTable("consumer_commits", {
  commitId: text("commit_id").primaryKey(),
  consumerId: text("consumer_id").notNull(),
  streamId: text("stream_id").notNull(),
  committedOffset: integer("committed_offset").notNull(),
  committedAt: text("committed_at").notNull(),
}, (table) => ({
  consumerCommittedOffsetIdx: index("idx_consumer_commits_consumer").on(table.consumerId, table.committedOffset),
}));
