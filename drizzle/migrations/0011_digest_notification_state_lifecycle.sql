CREATE TABLE digest_notification_states_new (
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  source_id TEXT REFERENCES sources(source_id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  notification_state_json TEXT NOT NULL,
  PRIMARY KEY (inbox_id, group_key)
);

-- Retain legacy deduplication state. Recover ownership from retained threads;
-- orphaned groups get a full retention window rather than expiring on upgrade.
INSERT INTO digest_notification_states_new
  (inbox_id, group_key, source_id, updated_at, notification_state_json)
SELECT n.inbox_id, n.group_key,
  (
    SELECT t.source_id FROM digest_threads t
    JOIN sources s ON s.source_id = t.source_id
    WHERE t.inbox_id = n.inbox_id AND t.group_key = n.group_key
    ORDER BY t.updated_at DESC, t.rowid DESC LIMIT 1
  ),
  COALESCE((
    SELECT MAX(t.updated_at) FROM digest_threads t
    WHERE t.inbox_id = n.inbox_id AND t.group_key = n.group_key
  ), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  n.notification_state_json
FROM digest_notification_states n;

DROP TABLE digest_notification_states;
ALTER TABLE digest_notification_states_new RENAME TO digest_notification_states;
CREATE INDEX idx_digest_notification_states_source ON digest_notification_states(source_id);
CREATE INDEX idx_digest_notification_states_updated ON digest_notification_states(updated_at);
