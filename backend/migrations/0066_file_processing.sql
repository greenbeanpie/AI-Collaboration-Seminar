-- One durable pipeline per uploaded file lifecycle. Historical outputs remain immutable.
ALTER TABLE files ADD COLUMN processing_purpose TEXT CHECK(processing_purpose IN ('background','reference','output'));
CREATE TABLE file_processing (
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, lifecycle_version INTEGER NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_id TEXT NOT NULL,
 source_version_id TEXT NOT NULL, job_id TEXT, attempted INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(file_id,lifecycle_version)
);
CREATE INDEX file_processing_project ON file_processing(project_id,updated_at);
CREATE TABLE file_derivations (
 file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, parent_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE
);
CREATE TABLE file_processing_materials (
 source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
 material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE, text_hash TEXT NOT NULL,
 parent_material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,
 PRIMARY KEY(source_version_id,material_id)
);
