CREATE TABLE ai_probes (
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 purpose TEXT NOT NULL,
 passed INTEGER NOT NULL DEFAULT 0,
 report_json TEXT NOT NULL,
 tested_at TEXT NOT NULL,
 PRIMARY KEY (config_version_id, purpose)
);
