-- Human decisions remain available independently of model availability.
ALTER TABLE assessments ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assessments ADD COLUMN origin TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE assessments ADD COLUMN ai_report_json TEXT;
CREATE TABLE assessment_corrections (
 id TEXT PRIMARY KEY,
 assessment_id TEXT NOT NULL REFERENCES assessments(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL,
 previous_report_json TEXT,
 report_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(assessment_id,revision)
);
