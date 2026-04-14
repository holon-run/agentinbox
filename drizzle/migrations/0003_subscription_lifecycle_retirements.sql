create table if not exists subscription_lifecycle_retirements (
  subscription_id text primary key,
  source_id text not null,
  tracked_resource_ref text not null,
  retire_at text not null,
  terminal_state text,
  terminal_result text,
  terminal_occurred_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_subscription_lifecycle_retirements_retire_at
  on subscription_lifecycle_retirements(retire_at);
