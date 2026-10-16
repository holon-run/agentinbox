ALTER TABLE stream_events ADD COLUMN payload_pruned_at TEXT;
CREATE INDEX idx_stream_events_retained_offset
  ON stream_events (stream_id, offset) WHERE payload_pruned_at IS NULL;
CREATE INDEX idx_stream_events_pruned_offset
  ON stream_events (stream_id, offset) WHERE payload_pruned_at IS NOT NULL;
CREATE INDEX idx_stream_events_pruned_occurred_at
  ON stream_events (stream_id, occurred_at) WHERE payload_pruned_at IS NOT NULL;
CREATE INDEX idx_consumers_stream_next_offset ON consumers (stream_id, next_offset);
