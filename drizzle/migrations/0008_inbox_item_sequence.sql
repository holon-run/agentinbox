alter table inbox_items add column inbox_sequence integer;

update inbox_items
set inbox_sequence = rowid
where inbox_sequence is null;

create unique index if not exists idx_inbox_items_inbox_sequence
  on inbox_items(inbox_sequence);

create index if not exists idx_inbox_items_inbox_sequence_order
  on inbox_items(inbox_id, inbox_sequence);

create trigger if not exists trg_inbox_items_set_sequence_after_insert
after insert on inbox_items
for each row
when new.inbox_sequence is null
begin
  update inbox_items
  set inbox_sequence = new.rowid
  where rowid = new.rowid;
end;
