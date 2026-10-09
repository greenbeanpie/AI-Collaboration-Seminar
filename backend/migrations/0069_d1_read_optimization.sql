CREATE INDEX idx_reservations_active_job_created
  ON usage_reservations(job_id, created_at DESC) WHERE status = 'reserved';
CREATE INDEX idx_ai_calls_job ON ai_calls(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE ai_diagnostic_retention (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0)
);
INSERT INTO ai_diagnostic_retention(id, entry_count, byte_count)
  SELECT 1, COUNT(*), COALESCE(SUM(byte_size), 0) FROM ai_diagnostics;

CREATE TRIGGER ai_diagnostics_retention_insert AFTER INSERT ON ai_diagnostics
BEGIN
  UPDATE ai_diagnostic_retention SET entry_count = entry_count + 1,
    byte_count = byte_count + NEW.byte_size WHERE id = 1;
END;
CREATE TRIGGER ai_diagnostics_retention_delete AFTER DELETE ON ai_diagnostics
BEGIN
  UPDATE ai_diagnostic_retention SET entry_count = entry_count - 1,
    byte_count = byte_count - OLD.byte_size WHERE id = 1;
END;
CREATE TRIGGER ai_diagnostics_retention_update AFTER UPDATE OF byte_size ON ai_diagnostics
BEGIN
  UPDATE ai_diagnostic_retention SET byte_count = byte_count + NEW.byte_size - OLD.byte_size WHERE id = 1;
END;
