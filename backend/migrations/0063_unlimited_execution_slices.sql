-- Preserve existing instance identifiers and checkpoints while removing the legacy slice ceiling.
CREATE TABLE ai_execution_slices_unlimited (
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 slice INTEGER NOT NULL CHECK(slice >= 0),
 instance_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','dispatched','running','continued','complete')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,slice)
);
INSERT INTO ai_execution_slices_unlimited SELECT * FROM ai_execution_slices;
DROP TABLE ai_execution_slices;
ALTER TABLE ai_execution_slices_unlimited RENAME TO ai_execution_slices;
CREATE INDEX ai_execution_slices_pending ON ai_execution_slices(status,updated_at);
