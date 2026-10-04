CREATE TABLE resource_index_state (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('source','material')),
 version_id TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0,
 next_seq INTEGER NOT NULL DEFAULT 0,
 heading TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','ready')),
 PRIMARY KEY(project_id,resource_type,version_id)
);
CREATE TABLE resource_index_blocks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL,
 version_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 fragment_id TEXT,
 page_number INTEGER,
 heading TEXT NOT NULL DEFAULT '',
 start_offset INTEGER NOT NULL,
 end_offset INTEGER NOT NULL,
 content TEXT NOT NULL,
 UNIQUE(project_id,resource_type,version_id,seq)
);
CREATE INDEX idx_resource_blocks_version ON resource_index_blocks(project_id,resource_type,version_id,seq);
CREATE VIRTUAL TABLE resource_index_fts USING fts5(content, block_id UNINDEXED, tokenize='trigram');
CREATE TRIGGER resource_index_insert AFTER INSERT ON resource_index_blocks BEGIN
 INSERT INTO resource_index_fts(rowid,content,block_id) VALUES(new.rowid,new.content,new.id);
END;
CREATE TRIGGER resource_index_delete AFTER DELETE ON resource_index_blocks BEGIN
 DELETE FROM resource_index_fts WHERE rowid=old.rowid;
END;
