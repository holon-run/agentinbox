create table if not exists sources (
  source_id text primary key,
  source_type text not null,
  source_key text not null,
  config_ref text,
  config_json text not null,
  status text not null,
  checkpoint text,
  created_at text not null,
  updated_at text not null,
  unique(source_type, source_key)
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
  created_at text not null
);

create table if not exists subscriptions (
  subscription_id text primary key,
  agent_id text not null,
  source_id text not null,
  filter_json text not null,
  lifecycle_mode text not null,
  expires_at text,
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
  last_seen_at text not null
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

