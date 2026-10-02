-- Recoverable lifecycle tombstones; no originals, references or business rows are deleted.
ALTER TABLE files ADD COLUMN deleted_at TEXT;
ALTER TABLE files ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE files ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN lifecycle_change_id TEXT;
ALTER TABLE sources ADD COLUMN deleted_at TEXT;
ALTER TABLE sources ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE sources ADD COLUMN deleted_via_file_id TEXT REFERENCES files(id);
ALTER TABLE sources ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN lifecycle_change_id TEXT;
CREATE INDEX idx_files_recycle ON files(project_id, deleted_at, created_at, id);
CREATE INDEX idx_sources_recycle ON sources(project_id, deleted_at, created_at, id);
