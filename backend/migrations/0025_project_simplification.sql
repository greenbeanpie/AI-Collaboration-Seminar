-- One project goal; preserve all existing task identities, states and history.
CREATE TABLE project_goals (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1, graph_revision INTEGER NOT NULL DEFAULT 1,
 graph_token TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO project_goals(project_id,title,detail,created_at,updated_at)
 SELECT id,name,description,created_at,updated_at FROM projects;
CREATE UNIQUE INDEX idx_tasks_project_id ON tasks(project_id,id);
CREATE TABLE task_dependencies (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,depends_on_task_id), CHECK(task_id != depends_on_task_id),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,depends_on_task_id) REFERENCES tasks(project_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_task_dependencies_project ON task_dependencies(project_id);
CREATE TABLE standards_versions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
 requirement_set_ids_json TEXT NOT NULL DEFAULT '[]', rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
 mappings_json TEXT NOT NULL DEFAULT '[]', snapshot_json TEXT,
 revision INTEGER NOT NULL DEFAULT 1, confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,version)
);
CREATE TABLE assessments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('material_review','rehearsal')), entity_id TEXT UNIQUE,
 goal_revision INTEGER NOT NULL, standards_version_id TEXT NOT NULL REFERENCES standards_versions(id),
 inputs_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','succeeded','failed')),
 report_json TEXT, job_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX idx_assessments_project ON assessments(project_id,created_at);
ALTER TABLE rehearsals ADD COLUMN finish_job_id TEXT;
ALTER TABLE rehearsals ADD COLUMN finish_snapshot_json TEXT;
ALTER TABLE tasks ADD COLUMN plan_proposal_id TEXT;
