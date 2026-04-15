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

create index if not exists idx_timers_agent_next_fire_at
  on timers(agent_id, next_fire_at);

create index if not exists idx_timers_next_fire_at
  on timers(next_fire_at);
