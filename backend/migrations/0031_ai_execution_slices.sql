CREATE TABLE ai_execution_slices (
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 slice INTEGER NOT NULL CHECK(slice >= 0 AND slice < 512),
 instance_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','dispatched','running','continued','complete')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,slice)
);
CREATE INDEX ai_execution_slices_pending ON ai_execution_slices(status,updated_at);
