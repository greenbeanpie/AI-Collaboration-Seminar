CREATE TABLE task_agent_eligibility (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  eligible INTEGER CHECK(eligible IN (0,1)),
  reason TEXT,
  job_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,task_id,source_hash)
);
CREATE INDEX idx_task_agent_eligibility_job ON task_agent_eligibility(job_id);
