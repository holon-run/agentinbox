alter table activation_dispatch_states add column defer_reason text;
alter table activation_dispatch_states add column defer_attempts integer not null default 0;
alter table activation_dispatch_states add column first_deferred_at text;
alter table activation_dispatch_states add column last_deferred_at text;
alter table activation_dispatch_states add column pending_fingerprint text;
