alter table inbox_items add column inbox_sequence integer;

update inbox_items
set inbox_sequence = rowid
where inbox_sequence is null;

create unique index if not exists idx_inbox_items_inbox_sequence
  on inbox_items(inbox_sequence);

create index if not exists idx_inbox_items_inbox_sequence_order
  on inbox_items(inbox_id, inbox_sequence);
