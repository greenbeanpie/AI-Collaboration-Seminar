ALTER TABLE usage_reservations ADD COLUMN attempts_started INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_calls ADD COLUMN reservation_id TEXT REFERENCES usage_reservations(id);
CREATE INDEX idx_ai_calls_reservation ON ai_calls(reservation_id);
