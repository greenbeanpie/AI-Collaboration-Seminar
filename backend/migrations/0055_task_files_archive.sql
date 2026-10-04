-- Additive lifecycle metadata; historical version attachments and R2 keys remain immutable.
ALTER TABLE files ADD COLUMN archived_at TEXT;
ALTER TABLE materials ADD COLUMN task_id TEXT REFERENCES tasks(id);
ALTER TABLE materials ADD COLUMN archived_at TEXT;
CREATE INDEX idx_materials_task ON materials(project_id,task_id);
CREATE TABLE task_file_uploads (
  file_id TEXT PRIMARY KEY REFERENCES files(id),
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE
);
CREATE INDEX idx_task_file_uploads_material ON task_file_uploads(material_id);
