CREATE TABLE ocr_model_capabilities (
  endpoint_model_hash TEXT PRIMARY KEY,
  single_image_only INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE source_ocr_batches (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  lifecycle_version INTEGER NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  page_numbers_json TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','ok','partial','failed','rejected')),
  context_chars INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX source_ocr_batches_version ON source_ocr_batches(source_version_id, created_at);
