CREATE TABLE digest_notification_states (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  notification_state_json TEXT NOT NULL,
  PRIMARY KEY (inbox_id, group_key)
);
