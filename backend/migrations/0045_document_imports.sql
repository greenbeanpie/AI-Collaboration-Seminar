CREATE TABLE file_upload_sessions (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL, upload_id TEXT NOT NULL,
 r2_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, part_bytes INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing','complete','aborting','aborted')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX file_upload_active ON file_upload_sessions(file_id,lifecycle_version) WHERE status IN ('uploading','completing','aborting');
CREATE TABLE file_upload_parts (
 session_id TEXT NOT NULL REFERENCES file_upload_sessions(id), part_number INTEGER NOT NULL,
 etag TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,part_number)
);
CREATE TABLE document_parse_sessions (
 id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('browser-pdf','browser-docx')), status TEXT NOT NULL DEFAULT 'processing',
 next_batch INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 1,
 warnings_json TEXT NOT NULL DEFAULT '[]', total_pages INTEGER, processed_pages INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX document_parse_active ON document_parse_sessions(source_version_id,lifecycle_version) WHERE status='processing';
CREATE TABLE document_parse_batches (
 session_id TEXT NOT NULL REFERENCES document_parse_sessions(id), batch_number INTEGER NOT NULL,
 digest TEXT NOT NULL, PRIMARY KEY(session_id,batch_number)
);
ALTER TABLE source_versions ADD COLUMN extraction_method TEXT;
ALTER TABLE source_versions ADD COLUMN extraction_warnings_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE source_fragments ADD COLUMN heading_path TEXT;
ALTER TABLE source_fragments ADD COLUMN extraction_session_id TEXT;

CREATE TABLE document_parse_pages (
 session_id TEXT NOT NULL REFERENCES document_parse_sessions(id), page_number INTEGER NOT NULL,
 PRIMARY KEY(session_id,page_number)
);
ALTER TABLE source_versions ADD COLUMN extraction_coverage TEXT;

ALTER TABLE file_upload_sessions ADD COLUMN operation_token TEXT;
ALTER TABLE file_upload_sessions ADD COLUMN operation_expires_at TEXT;
CREATE TABLE file_upload_part_leases (
 session_id TEXT NOT NULL REFERENCES file_upload_sessions(id), part_number INTEGER NOT NULL,
 lease_owner TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(session_id,part_number)
);
