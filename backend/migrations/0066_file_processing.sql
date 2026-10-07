-- One durable pipeline per uploaded file lifecycle. Historical outputs remain immutable.
CREATE TABLE file_processing (
 file_id TEXT NOT NULL REFERENCES files(id), lifecycle_version INTEGER NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id), source_id TEXT NOT NULL,
 source_version_id TEXT NOT NULL, job_id TEXT, attempted INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(file_id,lifecycle_version)
);
CREATE INDEX file_processing_project ON file_processing(project_id,updated_at);
CREATE TABLE file_derivations (
 file_id TEXT PRIMARY KEY REFERENCES files(id), parent_file_id TEXT NOT NULL REFERENCES files(id)
);
CREATE TABLE file_processing_materials (
 source_version_id TEXT NOT NULL REFERENCES source_versions(id),
 material_id TEXT NOT NULL REFERENCES materials(id), text_hash TEXT NOT NULL,
 parent_material_id TEXT REFERENCES materials(id),
 PRIMARY KEY(source_version_id,material_id)
);
