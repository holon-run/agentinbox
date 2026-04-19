pragma foreign_keys=off;

create table if not exists subscription_lifecycle_retirements__new (
  subscription_id text primary key,
  host_id text not null,
  tracked_resource_ref text not null,
  retire_at text not null,
  terminal_state text,
  terminal_result text,
  terminal_occurred_at text not null,
  created_at text not null,
  updated_at text not null
);

insert into subscription_lifecycle_retirements__new (
  subscription_id,
  host_id,
  tracked_resource_ref,
  retire_at,
  terminal_state,
  terminal_result,
  terminal_occurred_at,
  created_at,
  updated_at
)
select
  retirement.subscription_id,
  coalesce(source.host_id, retirement.source_id),
  retirement.tracked_resource_ref,
  retirement.retire_at,
  retirement.terminal_state,
  retirement.terminal_result,
  retirement.terminal_occurred_at,
  retirement.created_at,
  retirement.updated_at
from subscription_lifecycle_retirements as retirement
left join sources as source on source.source_id = retirement.source_id;

drop table subscription_lifecycle_retirements;
alter table subscription_lifecycle_retirements__new rename to subscription_lifecycle_retirements;

pragma foreign_keys=on;
