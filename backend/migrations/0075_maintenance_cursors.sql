-- Persistent keyset position prevents protected reservations from starving later candidates.
CREATE TABLE maintenance_cursors (
  name TEXT PRIMARY KEY,
  cursor_created_at TEXT,
  cursor_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reservations_active_sweep ON usage_reservations(created_at,id) WHERE status='reserved';
