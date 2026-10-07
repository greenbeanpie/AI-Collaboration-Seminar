-- Rebuild the CHECK with both child tables, preserving all session IDs and rows.
-- No foreign_keys=OFF: D1 always enforces foreign keys and runs migrations atomically.
CREATE TABLE document_parse_sessions_office (
 id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('browser-pdf','browser-docx','browser-xlsx','browser-pptx')), status TEXT NOT NULL DEFAULT 'processing',
 next_batch INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 1,
 warnings_json TEXT NOT NULL DEFAULT '[]', total_pages INTEGER, processed_pages INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO document_parse_sessions_office SELECT * FROM document_parse_sessions;
CREATE TABLE document_parse_batches_office (
 session_id TEXT NOT NULL REFERENCES document_parse_sessions_office(id), batch_number INTEGER NOT NULL,
 digest TEXT NOT NULL, PRIMARY KEY(session_id,batch_number)
);
INSERT INTO document_parse_batches_office SELECT * FROM document_parse_batches;
CREATE TABLE document_parse_pages_office (
 session_id TEXT NOT NULL REFERENCES document_parse_sessions_office(id), page_number INTEGER NOT NULL,
 PRIMARY KEY(session_id,page_number)
);
INSERT INTO document_parse_pages_office SELECT * FROM document_parse_pages;
DROP TABLE document_parse_batches;
DROP TABLE document_parse_pages;
DROP TABLE document_parse_sessions;
ALTER TABLE document_parse_sessions_office RENAME TO document_parse_sessions;
ALTER TABLE document_parse_batches_office RENAME TO document_parse_batches;
ALTER TABLE document_parse_pages_office RENAME TO document_parse_pages;
CREATE UNIQUE INDEX document_parse_active ON document_parse_sessions(source_version_id,lifecycle_version) WHERE status IN ('processing','finalizing');
