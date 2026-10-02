CREATE TABLE task_summaries (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  job_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, source_hash)
);
