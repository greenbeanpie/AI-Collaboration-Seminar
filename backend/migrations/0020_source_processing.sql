-- Independent content extraction, requirements and document summary states.
-- Original files and historical source/requirement snapshots are retained.
CREATE TABLE source_processing (
  source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text_status TEXT NOT NULL DEFAULT 'pending' CHECK (text_status IN ('pending','processing','waiting_input','ready','failed')),
  requirements_status TEXT NOT NULL DEFAULT 'pending' CHECK (requirements_status IN ('pending','processing','ready','failed')),
  requirements_error TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','queued','running','ready','failed','cancelled')),
  summary_json TEXT,
  summary_error TEXT,
  summary_job_id TEXT,
  summary_revision INTEGER NOT NULL DEFAULT 0,
  covered_chars INTEGER,
  total_chars INTEGER,
  updated_at TEXT NOT NULL
);
