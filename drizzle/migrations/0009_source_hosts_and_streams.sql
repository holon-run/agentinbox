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

create unique index if not exists idx_source_hosts_type_key
  on source_hosts(host_type, host_key);

alter table sources add column host_id text;
alter table sources add column stream_kind text;
alter table sources add column stream_key text;
alter table sources add column compat_source_type text;

update sources
set compat_source_type = source_type
where compat_source_type is null;

update sources
set stream_kind = case source_type
  when 'github_repo' then 'repo_events'
  when 'github_repo_ci' then 'ci_runs'
  when 'feishu_bot' then 'message_events'
  when 'local_event' then 'events'
  else 'default'
end
where stream_kind is null;

update sources
set stream_key = source_key
where stream_key is null;

insert or ignore into source_hosts (
  host_id,
  host_type,
  host_key,
  config_ref,
  config_json,
  status,
  created_at,
  updated_at
)
select
  case
    when host_type = 'github' then
      'hst_github_' || replace(lower(hex(host_key)), ' ', '')
    when host_type = 'feishu' then
      'hst_feishu_' || replace(lower(hex(host_key)), ' ', '')
    when host_type = 'local_event' then
      'hst_local_event_' || replace(lower(hex(host_key)), ' ', '')
    else
      'hst_remote_source_' || replace(lower(hex(host_key)), ' ', '')
  end as host_id,
  host_type,
  host_key,
  config_ref,
  config_json,
  status,
  created_at,
  updated_at
from (
  select distinct
    case
      when source_type in ('github_repo', 'github_repo_ci') then 'github'
      when source_type = 'feishu_bot' then 'feishu'
      when source_type = 'local_event' then 'local_event'
      else 'remote_source'
    end as host_type,
    case
      when source_type in ('github_repo', 'github_repo_ci') then
        'uxcAuth:' || coalesce(json_extract(config_json, '$.uxcAuth'), config_ref, 'default')
      when source_type = 'feishu_bot' then
        'app:' || coalesce(json_extract(config_json, '$.appId'), config_ref, source_id)
      when source_type = 'local_event' then
        source_key
      else
        source_key
    end as host_key,
    config_ref,
    case
      when source_type in ('github_repo', 'github_repo_ci') then
        json_object('uxcAuth', json_extract(config_json, '$.uxcAuth'))
      when source_type = 'feishu_bot' then
        json_object(
          'appId', json_extract(config_json, '$.appId'),
          'appSecret', json_extract(config_json, '$.appSecret'),
          'schemaUrl', coalesce(json_extract(config_json, '$.schemaUrl'), json_extract(config_json, '$.schema_url')),
          'replyInThread', coalesce(json_extract(config_json, '$.replyInThread'), json_extract(config_json, '$.reply_in_thread')),
          'uxcAuth', json_extract(config_json, '$.uxcAuth')
        )
      when source_type = 'local_event' then
        json('{}')
      else
        config_json
    end as config_json,
    status,
    created_at,
    updated_at
  from sources
);

update sources
set host_id = (
  select host_id
  from source_hosts
  where source_hosts.host_type = case
    when sources.source_type in ('github_repo', 'github_repo_ci') then 'github'
    when sources.source_type = 'feishu_bot' then 'feishu'
    when sources.source_type = 'local_event' then 'local_event'
    else 'remote_source'
  end
    and source_hosts.host_key = case
      when sources.source_type in ('github_repo', 'github_repo_ci') then
        'uxcAuth:' || coalesce(json_extract(sources.config_json, '$.uxcAuth'), sources.config_ref, 'default')
      when sources.source_type = 'feishu_bot' then
        'app:' || coalesce(json_extract(sources.config_json, '$.appId'), sources.config_ref, sources.source_id)
      when sources.source_type = 'local_event' then
        sources.source_key
      else
        sources.source_key
    end
)
where host_id is null;

create table if not exists sources__new (
  source_id text primary key,
  host_id text not null,
  stream_kind text not null,
  stream_key text not null,
  compat_source_type text,
  source_type text not null,
  source_key text not null,
  config_ref text,
  config_json text not null,
  status text not null,
  checkpoint text,
  created_at text not null,
  updated_at text not null
);

insert into sources__new (
  source_id, host_id, stream_kind, stream_key, compat_source_type,
  source_type, source_key, config_ref, config_json,
  status, checkpoint, created_at, updated_at
)
select
  source_id, host_id, stream_kind, stream_key, compat_source_type,
  source_type, source_key, config_ref, config_json,
  status, checkpoint, created_at, updated_at
from sources;

drop table sources;
alter table sources__new rename to sources;

create index if not exists idx_sources_type_key
  on sources(source_type, source_key);

create unique index if not exists idx_sources_host_stream_key
  on sources(host_id, stream_kind, stream_key);
