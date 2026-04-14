create table subscriptions__new (
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

insert into subscriptions__new (
  subscription_id,
  agent_id,
  source_id,
  filter_json,
  tracked_resource_ref,
  cleanup_policy_json,
  start_policy,
  start_offset,
  start_time,
  created_at
)
select
  subscription_id,
  agent_id,
  source_id,
  filter_json,
  null as tracked_resource_ref,
  case
    when expires_at is not null then json_object('mode', 'at', 'at', expires_at)
    when lifecycle_mode = 'temporary' then json_object('mode', 'manual')
    else json_object('mode', 'manual')
  end as cleanup_policy_json,
  start_policy,
  start_offset,
  start_time,
  created_at
from subscriptions;

drop table subscriptions;

alter table subscriptions__new rename to subscriptions;
