CREATE TABLE audio_pipeline (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 phase TEXT NOT NULL DEFAULT 'pending',
 transcript_r2_key TEXT,
 quality_json TEXT NOT NULL DEFAULT '[]',
 chunks_json TEXT NOT NULL DEFAULT '[]',
 final_summary_json TEXT,
 summaries_json TEXT NOT NULL DEFAULT '[]',
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 fallback_config_version_id TEXT REFERENCES ai_config_versions(id),
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE audio_pipeline_calls (
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES jobs(id),
 stage TEXT NOT NULL,
 block_index INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','ok','invalid','unknown')),
 created_at TEXT NOT NULL,
 UNIQUE(job_id,stage,block_index)
);
CREATE INDEX audio_pipeline_phase ON audio_pipeline(phase,updated_at);
