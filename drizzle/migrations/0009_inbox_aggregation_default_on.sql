-- Aggregation is now enabled by default for agent inboxes: bursty events on
-- the same resource collapse into one digest notification instead of waking
-- the agent once per event. Existing inboxes were left disabled by the old
-- default, so flip them on in bulk; explicit opt-outs can set the flag back
-- to 0 per inbox via the inbox aggregation policy.
update inboxes
set aggregation_enabled = 1
where aggregation_enabled = 0;
