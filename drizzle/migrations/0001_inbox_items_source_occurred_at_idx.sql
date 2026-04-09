create index if not exists idx_inbox_items_source_occurred_at
  on inbox_items(source_id, occurred_at);

