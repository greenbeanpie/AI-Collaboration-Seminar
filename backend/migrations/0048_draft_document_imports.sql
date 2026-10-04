CREATE TABLE draft_document_uploads(
 file_id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id) ON DELETE CASCADE,
 upload_id TEXT NOT NULL,
 r2_key TEXT NOT NULL,
 name TEXT NOT NULL,
 ext TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','complete','cancelled'))
);
CREATE TABLE draft_document_parts(
 file_id TEXT NOT NULL REFERENCES draft_document_uploads(file_id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL,
 etag TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 PRIMARY KEY(file_id,part_number)
);
CREATE TABLE draft_document_blocks(
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL REFERENCES creation_draft_files(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,
 page_number INTEGER,
 content TEXT NOT NULL,
 heading_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(file_id,seq)
);
CREATE TABLE draft_document_imports(
 file_id TEXT PRIMARY KEY REFERENCES creation_draft_files(id) ON DELETE CASCADE,
 draft_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'importing' CHECK(status IN ('importing','complete','partial')),
 warnings_json TEXT NOT NULL DEFAULT '[]'
);
