CREATE TABLE recording_sessions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 created_by TEXT NOT NULL REFERENCES users(id), client_session_id TEXT NOT NULL,
 material_id TEXT NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
 title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('audio','video','photo')),
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','complete')),
 processing_status TEXT NOT NULL DEFAULT 'pending', contributor_ids_json TEXT NOT NULL DEFAULT '[]',
 interruptions_json TEXT NOT NULL DEFAULT '[]', segment_count INTEGER NOT NULL DEFAULT 0,
 summary_revision INTEGER NOT NULL DEFAULT 0, summary_job_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(project_id,created_by,client_session_id)
);
CREATE INDEX idx_recordings_project ON recording_sessions(project_id,created_at,id);
CREATE TABLE recording_segments (
 session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>=1), file_id TEXT NOT NULL REFERENCES files(id),
 source_id TEXT NOT NULL REFERENCES sources(id), source_version_id TEXT NOT NULL REFERENCES source_versions(id),
 start_ms INTEGER NOT NULL CHECK(start_ms>=0),end_ms INTEGER NOT NULL CHECK(end_ms>=start_ms),
 sha256 TEXT NOT NULL,interruptions_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,
 PRIMARY KEY(session_id,sequence),UNIQUE(session_id,file_id)
);
CREATE INDEX idx_recording_source ON recording_segments(source_id);
CREATE TABLE recording_summary_nodes (
 session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, level INTEGER NOT NULL, node_index INTEGER NOT NULL,
 summary TEXT NOT NULL, citations_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 PRIMARY KEY(session_id,revision,level,node_index)
);
