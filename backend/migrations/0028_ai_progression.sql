ALTER TABLE projects ADD COLUMN planning_mode TEXT NOT NULL DEFAULT 'manual' CHECK(planning_mode IN ('manual','automatic'));
ALTER TABLE projects ADD COLUMN progression_mode TEXT NOT NULL DEFAULT 'manual' CHECK(progression_mode IN ('manual','automatic'));
CREATE TABLE project_progression (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 observed_event_at TEXT NOT NULL DEFAULT '',
 observed_event_id TEXT NOT NULL DEFAULT '',
 pending_job_id TEXT,
 pending_event_at TEXT, pending_event_id TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE project_admin_feedback (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL,
 target_id TEXT, feedback TEXT NOT NULL, request_ai_redo INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_project_admin_feedback_project ON project_admin_feedback(project_id,created_at);
CREATE TABLE collaboration_proposal_revisions (
 id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES collaboration_proposals(id),
 project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(proposal_id,revision)
);
