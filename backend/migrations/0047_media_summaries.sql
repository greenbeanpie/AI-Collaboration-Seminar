CREATE TABLE media_processing (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  source_version_id TEXT REFERENCES source_versions(id),
  draft_file_id TEXT REFERENCES creation_draft_files(id),
  config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
  stage TEXT NOT NULL DEFAULT 'pending' CHECK(stage IN ('pending','uploading','processing','generating','ready','failed')),
  provider_name TEXT,
  provider_uri TEXT,
  duration_seconds REAL,
  windows_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT,
  error TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((source_version_id IS NULL) != (draft_file_id IS NULL))
);
CREATE INDEX media_cleanup ON media_processing(cleanup_pending,updated_at);
CREATE TABLE media_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
  model TEXT NOT NULL,
  window_start REAL NOT NULL,
  window_end REAL,
  status TEXT NOT NULL CHECK(status IN ('started','ok','failed','unknown')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_status IN ('known','unknown')),
  created_at TEXT NOT NULL
);
