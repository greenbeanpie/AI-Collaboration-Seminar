ALTER TABLE material_versions ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE source_versions ADD COLUMN ai_config_version_id TEXT REFERENCES ai_config_versions(id);
ALTER TABLE files ADD COLUMN original_name TEXT NOT NULL DEFAULT '';
