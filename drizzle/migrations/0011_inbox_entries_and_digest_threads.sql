alter table inboxes add column aggregation_enabled integer not null default 0;
alter table inboxes add column aggregation_window_ms integer;
alter table inboxes add column aggregation_max_items integer;
alter table inboxes add column aggregation_max_thread_age_ms integer;

create table if not exists digest_threads (
  thread_id integer primary key autoincrement,
  inbox_id text not null,
  source_id text not null,
  group_key text not null,
  resource_ref text,
  event_family text,
  latest_revision integer not null,
  latest_entry_id integer,
  status text not null,
  summary text not null,
  first_item_at text not null,
  last_item_at text not null,
  flush_after_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_digest_threads_inbox_status
  on digest_threads(inbox_id, status);

create index if not exists idx_digest_threads_group_status
  on digest_threads(inbox_id, group_key, status);

create index if not exists idx_digest_threads_flush_after
  on digest_threads(status, flush_after_at);

create table if not exists inbox_entries (
  entry_id integer primary key autoincrement,
  inbox_id text not null,
  kind text not null,
  sequence integer not null unique,
  thread_id integer,
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

create index if not exists idx_inbox_entries_inbox_visible
  on inbox_entries(inbox_id, acked_at, superseded_at, sequence);

create index if not exists idx_inbox_entries_thread_revision
  on inbox_entries(thread_id, revision);

create table if not exists inbox_entry_items (
  entry_id integer not null,
  item_id text not null,
  primary key (entry_id, item_id)
);

create index if not exists idx_inbox_entry_items_item
  on inbox_entry_items(item_id);

create table if not exists digest_thread_items (
  thread_id integer not null,
  item_id text not null,
  primary key (thread_id, item_id)
);

create index if not exists idx_digest_thread_items_item
  on digest_thread_items(item_id);
