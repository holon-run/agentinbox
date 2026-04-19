create table if not exists sources (
  source_id text primary key,
  host_id text not null,
  stream_kind text not null,
  stream_key text not null,
  source_type text not null,
  source_key text not null,
  config_ref text,
  config_json text not null,
  status text not null,
  checkpoint text,
  created_at text not null,
  updated_at text not null
);

create table if not exists agents (
  agent_id text primary key,
  status text not null,
  offline_since text,
  runtime_kind text not null,
  runtime_session_id text,
  created_at text not null,
  updated_at text not null,
  last_seen_at text not null
);

create table if not exists inboxes (
  inbox_id text primary key,
  owner_agent_id text not null unique,
  created_at text not null,
  aggregation_enabled integer not null default 0,
  aggregation_window_ms integer,
  aggregation_max_items integer,
  aggregation_max_thread_age_ms integer
);

create table if not exists subscriptions (
  subscription_id text primary key,
  agent_id text not null,
  source_id text not null,
  filter_json text not null,
  tracked_resource_ref text,
  cleanup_policy_json text not null,
  start_policy text not null,
  start_offset integer,
  start_time text,
  created_at text not null
);

create table if not exists activation_targets (
  target_id text primary key,
  agent_id text not null,
  kind text not null,
  status text not null,
  offline_since text,
  consecutive_failures integer not null,
  last_delivered_at text,
  last_error text,
  mode text not null,
  notify_lease_ms integer not null,
  url text,
  runtime_kind text,
  runtime_session_id text,
  backend text,
  tmux_pane_id text,
  tty text,
  term_program text,
  iterm_session_id text,
  created_at text not null,
  updated_at text not null,
  last_seen_at text not null,
  runtime_pid integer,
  min_unacked_items integer
);

create table if not exists activation_dispatch_states (
  agent_id text not null,
  target_id text not null,
  status text not null,
  lease_expires_at text,
  pending_new_item_count integer not null,
  pending_summary text,
  pending_subscription_ids_json text not null,
  pending_source_ids_json text not null,
  updated_at text not null,
  last_notified_fingerprint text,
  defer_reason text,
  defer_attempts integer not null default 0,
  first_deferred_at text,
  last_deferred_at text,
  pending_fingerprint text,
  primary key (agent_id, target_id)
);

create table if not exists inbox_items (
  item_id text primary key,
  source_id text not null,
  source_native_id text not null,
  event_variant text not null,
  inbox_id text not null,
  occurred_at text not null,
  metadata_json text not null,
  raw_payload_json text not null,
  delivery_handle_json text,
  acked_at text,
  inbox_sequence integer,
  unique(source_id, source_native_id, event_variant, inbox_id)
);

create table if not exists activations (
  activation_id text primary key,
  kind text not null,
  agent_id text not null,
  inbox_id text not null,
  target_id text not null,
  target_kind text not null,
  subscription_ids_json text not null,
  source_ids_json text not null,
  new_item_count integer not null,
  summary text not null,
  items_json text,
  created_at text not null,
  delivered_at text
);

create table if not exists deliveries (
  delivery_id text primary key,
  provider text not null,
  surface text not null,
  target_ref text not null,
  thread_ref text,
  reply_mode text,
  kind text not null,
  payload_json text not null,
  status text not null,
  created_at text not null
);

create table if not exists streams (
  stream_id text primary key,
  source_id text not null unique,
  stream_key text not null unique,
  backend text not null,
  created_at text not null
);

create table if not exists stream_events (
  offset integer primary key autoincrement,
  stream_event_id text not null unique,
  stream_id text not null,
  source_id text not null,
  source_native_id text not null,
  event_variant text not null,
  occurred_at text not null,
  metadata_json text not null,
  raw_payload_json text not null,
  delivery_handle_json text,
  created_at text not null,
  unique(stream_id, source_native_id, event_variant)
);

create table if not exists consumers (
  consumer_id text primary key,
  stream_id text not null,
  subscription_id text not null unique,
  consumer_key text not null unique,
  start_policy text not null,
  start_offset integer,
  start_time text,
  next_offset integer not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists consumer_commits (
  commit_id text primary key,
  consumer_id text not null,
  stream_id text not null,
  committed_offset integer not null,
  committed_at text not null
);

create table if not exists subscription_lifecycle_retirements (
  subscription_id text primary key,
  host_id text not null,
  tracked_resource_ref text not null,
  retire_at text not null,
  terminal_state text,
  terminal_result text,
  terminal_occurred_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists source_idle_states (
  source_id text primary key not null,
  idle_since text not null,
  auto_pause_at text not null,
  auto_paused_at text,
  updated_at text not null
);

create table if not exists timers (
  schedule_id text primary key not null,
  agent_id text not null,
  status text not null,
  mode text not null,
  at text,
  interval_ms integer,
  cron_expr text,
  timezone text not null,
  message text not null,
  sender text,
  next_fire_at text,
  last_fired_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists source_hosts (
  host_id text primary key,
  host_type text not null,
  host_key text not null,
  config_ref text,
  config_json text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists digest_threads (
  thread_id text primary key,
  inbox_id text not null,
  source_id text not null,
  group_key text not null,
  resource_ref text,
  event_family text,
  latest_revision integer not null,
  latest_entry_id text,
  status text not null,
  summary text not null,
  first_item_at text not null,
  last_item_at text not null,
  flush_after_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists inbox_entries (
  entry_id text primary key,
  inbox_id text not null,
  kind text not null,
  sequence integer not null unique,
  thread_id text,
  revision integer,
  group_key text,
  resource_ref text,
  event_family text,
  item_json text,
  count integer not null,
  summary text not null,
  first_item_at text not null,
  last_item_at text not null,
  source_ids_json text not null,
  subscription_ids_json text not null,
  delivery_handle_json text,
  acked_at text,
  superseded_at text,
  created_at text not null
);

create table if not exists inbox_entry_items (
  entry_id text not null,
  item_id text not null,
  primary key (entry_id, item_id)
);

create table if not exists digest_thread_items (
  thread_id text not null,
  item_id text not null,
  primary key (thread_id, item_id)
);

create unique index if not exists idx_activation_targets_terminal_tmux
  on activation_targets(tmux_pane_id)
  where kind = 'terminal' and tmux_pane_id is not null;

create unique index if not exists idx_activation_targets_terminal_iterm
  on activation_targets(iterm_session_id)
  where kind = 'terminal' and iterm_session_id is not null;

create unique index if not exists idx_activation_targets_runtime_session
  on activation_targets(runtime_kind, runtime_session_id)
  where kind = 'terminal' and runtime_session_id is not null;

create index if not exists idx_activation_dispatch_states_target
  on activation_dispatch_states(target_id, lease_expires_at);

create index if not exists idx_inbox_items_acked_at
  on inbox_items(acked_at);

create index if not exists idx_inbox_items_inbox_acked_at
  on inbox_items(inbox_id, acked_at);

create index if not exists idx_agents_status_offline
  on agents(status, offline_since);

create index if not exists idx_activation_targets_agent_status
  on activation_targets(agent_id, status);

create index if not exists idx_stream_events_stream_offset
  on stream_events(stream_id, offset);

create index if not exists idx_stream_events_stream_occurred_at
  on stream_events(stream_id, occurred_at);

create index if not exists idx_consumers_stream
  on consumers(stream_id);

create index if not exists idx_consumer_commits_consumer
  on consumer_commits(consumer_id, committed_offset);

create index if not exists idx_subscription_lifecycle_retirements_retire_at
  on subscription_lifecycle_retirements(retire_at);

create index if not exists idx_source_idle_states_auto_pause_at
  on source_idle_states(auto_pause_at);

create index if not exists idx_timers_agent_next_fire_at
  on timers(agent_id, next_fire_at);

create index if not exists idx_timers_next_fire_at
  on timers(next_fire_at);

create unique index if not exists idx_source_hosts_type_key
  on source_hosts(host_type, host_key);

create unique index if not exists idx_sources_host_stream_key
  on sources(host_id, stream_kind, stream_key);

create index if not exists idx_sources_type_key
  on sources(source_type, source_key);

create unique index if not exists idx_inbox_items_inbox_sequence
  on inbox_items(inbox_sequence);

create index if not exists idx_inbox_items_inbox_sequence_order
  on inbox_items(inbox_id, inbox_sequence);

create index if not exists idx_inbox_items_source_occurred_at
  on inbox_items(source_id, occurred_at);

create index if not exists idx_digest_threads_inbox_status
  on digest_threads(inbox_id, status);

create index if not exists idx_digest_threads_group_status
  on digest_threads(inbox_id, group_key, status);

create index if not exists idx_digest_threads_flush_after
  on digest_threads(status, flush_after_at);

create index if not exists idx_inbox_entries_inbox_visible
  on inbox_entries(inbox_id, acked_at, superseded_at, sequence);

create index if not exists idx_inbox_entries_thread_revision
  on inbox_entries(thread_id, revision);

create index if not exists idx_inbox_entry_items_item
  on inbox_entry_items(item_id);

create index if not exists idx_digest_thread_items_item
  on digest_thread_items(item_id);

create trigger if not exists trg_inbox_items_set_sequence_after_insert
after insert on inbox_items
for each row
when new.inbox_sequence is null
begin
  update inbox_items
  set inbox_sequence = new.rowid
  where rowid = new.rowid;
end;
