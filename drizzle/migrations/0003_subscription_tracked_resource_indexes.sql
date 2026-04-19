create index if not exists idx_subscriptions_tracked_resource_ref
  on subscriptions(tracked_resource_ref);

create index if not exists idx_subscriptions_tracked_resource_source
  on subscriptions(tracked_resource_ref, source_id);
