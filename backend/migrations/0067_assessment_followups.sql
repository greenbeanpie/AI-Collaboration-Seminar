CREATE TABLE assessment_followups (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_report_json TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','conflict')),
  proposed_report_json TEXT,
  published_report_json TEXT,
  published_revision INTEGER,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX assessment_followups_history ON assessment_followups(project_id,assessment_id,created_at DESC,id DESC);
CREATE INDEX assessment_followups_job ON assessment_followups(job_id);
