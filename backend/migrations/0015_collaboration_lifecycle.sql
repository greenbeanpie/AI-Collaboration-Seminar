-- Additive only: preserve all existing project, job and material history.
ALTER TABLE projects ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'manual' CHECK (assignment_mode IN ('manual','automatic'));
ALTER TABLE projects ADD COLUMN evaluation_mode TEXT NOT NULL DEFAULT 'manual' CHECK (evaluation_mode IN ('manual','automatic'));
ALTER TABLE projects ADD COLUMN collaboration_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_members ADD COLUMN major TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN lifecycle_state TEXT CHECK (lifecycle_state IN ('open','in_progress','submitted','accepted','improve','rework'));
ALTER TABLE tasks ADD COLUMN criteria TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN current_submission_id TEXT;
CREATE TABLE task_submissions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, round INTEGER NOT NULL,
 submitted_by TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, material_versions_json TEXT NOT NULL DEFAULT '[]',
 criteria TEXT NOT NULL, task_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','evaluated','accept','improve','rework')),
 ai_decision TEXT CHECK(ai_decision IN ('accept','improve','rework')), ai_feedback TEXT,
 decision TEXT CHECK(decision IN ('accept','improve','rework')), feedback TEXT, decided_by TEXT,
 evaluation_job_id TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(task_id,round)
);
CREATE TABLE collaboration_proposals (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('decompose','assign')), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 payload_json TEXT NOT NULL, settings_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','stale')),
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_submissions_task ON task_submissions(project_id,task_id,round);
CREATE INDEX idx_collaboration_proposals ON collaboration_proposals(project_id,status,created_at);
ALTER TABLE tasks ADD COLUMN effort_hours REAL NOT NULL DEFAULT 1 CHECK(effort_hours > 0 AND effort_hours <= 200);
ALTER TABLE task_submissions ADD COLUMN evaluation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_submissions ADD COLUMN ai_report_json TEXT;
ALTER TABLE projects ADD COLUMN collaboration_mutation_token TEXT;
ALTER TABLE collaboration_proposals ADD COLUMN mutation_token TEXT;
ALTER TABLE task_submissions ADD COLUMN mutation_token TEXT;
