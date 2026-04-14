create table if not exists source_idle_states (
  source_id text primary key not null,
  idle_since text not null,
  auto_pause_at text not null,
  auto_paused_at text,
  updated_at text not null
);

create index if not exists idx_source_idle_states_auto_pause_at
  on source_idle_states(auto_pause_at);
