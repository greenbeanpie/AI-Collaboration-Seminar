-- Private creation state has no project FK: saving/uploading/previewing never creates a project.
CREATE TABLE project_creation_drafts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','committed')),
 revision INTEGER NOT NULL DEFAULT 1,
 payload_json TEXT NOT NULL,
 preview_json TEXT,
 preview_revision INTEGER,
 preview_state TEXT NOT NULL DEFAULT 'none' CHECK(preview_state IN ('none','running','ready','failed')),
 preview_attempt_id TEXT,
 preview_error TEXT,
 project_id TEXT NOT NULL UNIQUE,
 commit_token TEXT,
 result_encrypted TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_creation_drafts_owner ON project_creation_drafts(owner_id,updated_at);
CREATE TABLE creation_draft_files (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id),
 name TEXT NOT NULL,
 ext TEXT NOT NULL,
 r2_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 mime TEXT NOT NULL,
 pages_json TEXT NOT NULL DEFAULT '[]',
 text_error TEXT,
 removed INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
ALTER TABLE ai_calls ADD COLUMN draft_id TEXT REFERENCES project_creation_drafts(id);
ALTER TABLE ai_calls ADD COLUMN search_usage_json TEXT;
CREATE TABLE ai_tool_calls (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id),
 requested_by TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 args_json TEXT NOT NULL,
 result_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('ok','failed')),
 created_at TEXT NOT NULL
);

ALTER TABLE usage_reservations ADD COLUMN max_calls INTEGER NOT NULL DEFAULT 2;

CREATE INDEX idx_creation_draft_files_draft ON creation_draft_files(draft_id,removed,created_at,id);
CREATE INDEX idx_ai_tool_calls_job ON ai_tool_calls(project_id,job_id,created_at,id);
