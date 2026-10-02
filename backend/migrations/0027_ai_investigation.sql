CREATE TABLE ai_investigations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id), requested_by TEXT NOT NULL REFERENCES users(id),
 prompt_version TEXT NOT NULL, checkpoint_key TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'read', step INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_investigations_job ON ai_investigations(job_id,prompt_version);
