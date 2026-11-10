-- #278: status listings sort activations by created_at desc; without an
-- index every call pays a full-table sort on the synchronous store handle.
CREATE INDEX IF NOT EXISTS idx_activations_created_at
  ON activations(created_at);
