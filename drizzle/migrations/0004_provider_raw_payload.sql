alter table inbox_items add column provider_raw_payload_json text;

alter table stream_events add column provider_raw_payload_json text;
