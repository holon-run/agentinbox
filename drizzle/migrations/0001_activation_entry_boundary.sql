alter table activations add column latest_entry_id text;
alter table activations add column new_entry_count integer not null default 0;

update activations
set latest_entry_id = (
  select json_extract(items_json, '$[#-1].entryId')
),
new_entry_count = case
  when items_json is not null then json_array_length(items_json)
  else new_item_count
end;
