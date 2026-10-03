-- Keep existing draft rows and foreign keys intact; waiting is projected by the API.
ALTER TABLE project_creation_drafts ADD COLUMN preview_waiting_id TEXT;
ALTER TABLE project_creation_drafts ADD COLUMN preview_config_version_id TEXT REFERENCES ai_config_versions(id);
CREATE TABLE ai_clarifications (
 id TEXT PRIMARY KEY,
 project_id TEXT REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id),
 draft_id TEXT REFERENCES project_creation_drafts(id),
 owner_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL,
 context_revision INTEGER,
 tool_call_id TEXT NOT NULL,
 question_json TEXT NOT NULL,
 answer_json TEXT,
 transition_token TEXT,
 round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 3),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((job_id IS NOT NULL AND project_id IS NOT NULL AND draft_id IS NULL) OR (draft_id IS NOT NULL AND job_id IS NULL AND project_id IS NULL)),
 UNIQUE(attempt_id,tool_call_id)
);
CREATE INDEX idx_ai_clarifications_job ON ai_clarifications(job_id,owner_id,status,created_at);
CREATE INDEX idx_ai_clarifications_draft ON ai_clarifications(draft_id,attempt_id,created_at);
CREATE UNIQUE INDEX idx_ai_clarifications_one_pending ON ai_clarifications(attempt_id) WHERE status='pending';

-- Durable dispatch intent survives HTTP/process failure after an answer is saved.
CREATE TABLE draft_preview_dispatches (
 instance_id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id),
 attempt_id TEXT NOT NULL,
 context_revision INTEGER NOT NULL,
 question_id TEXT REFERENCES ai_clarifications(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_draft_preview_dispatches_pending ON draft_preview_dispatches(status,updated_at);
