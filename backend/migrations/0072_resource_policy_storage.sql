CREATE TABLE resource_policy (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1,
  policy_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO resource_policy VALUES(1,1,'{"aiEnabled":true,"userDailyCalls":300,"projectDailyCalls":1000,"platformDailyCalls":5000,"globalConcurrency":10,"userStorageBytes":250000000,"projectStorageBytes":1000000000,"platformStorageBytes":10000000000,"uploadPoolBytes":8000000000,"externalStorageBytes":0}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE resource_policy_audit (id TEXT PRIMARY KEY, actor_id TEXT, version INTEGER NOT NULL, policy_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE storage_inventory_state (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN(0,1)), external_checked_at TEXT, cursor TEXT, scanning INTEGER NOT NULL DEFAULT 0, verification_note TEXT, updated_at TEXT NOT NULL);
INSERT INTO storage_inventory_state(id,ready,updated_at) VALUES(1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE storage_objects (
  object_key TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0),
  project_id TEXT, user_id TEXT, category TEXT NOT NULL CHECK(category IN('upload','system')),
  etag TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_storage_objects_project ON storage_objects(project_id);
CREATE INDEX idx_storage_objects_user ON storage_objects(user_id);
CREATE TABLE storage_reservations (
  id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL CHECK(bytes>=0),
  project_id TEXT, user_id TEXT, category TEXT NOT NULL CHECK(category IN('upload','system')),
  kind TEXT NOT NULL CHECK(kind IN('put','multipart','delete')),
  status TEXT NOT NULL CHECK(status IN('reserved','uncertain')), upload_id TEXT, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_storage_reservations_expiry ON storage_reservations(expires_at);
CREATE TABLE storage_counters(scope TEXT NOT NULL,scope_id TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0),PRIMARY KEY(scope,scope_id));
CREATE TRIGGER storage_objects_count_insert AFTER INSERT ON storage_objects
BEGIN
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','all',1*NEW.size_bytes WHERE 1 ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','upload',1*NEW.size_bytes WHERE NEW.category='upload' ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'user',NEW.user_id,1*NEW.size_bytes WHERE NEW.user_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'project',NEW.project_id,1*NEW.size_bytes WHERE NEW.project_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER storage_objects_count_delete AFTER DELETE ON storage_objects
BEGIN
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='upload' AND OLD.category='upload';
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='user' AND scope_id=OLD.user_id AND OLD.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='project' AND scope_id=OLD.project_id AND OLD.project_id IS NOT NULL;
END;
CREATE TRIGGER storage_objects_count_update AFTER UPDATE OF size_bytes ON storage_objects
BEGIN
 UPDATE storage_counters SET bytes=bytes+NEW.size_bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes+NEW.size_bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='upload' AND NEW.category='upload';
 UPDATE storage_counters SET bytes=bytes+NEW.size_bytes-OLD.size_bytes WHERE scope='user' AND scope_id=NEW.user_id AND NEW.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes+NEW.size_bytes-OLD.size_bytes WHERE scope='project' AND scope_id=NEW.project_id AND NEW.project_id IS NOT NULL;
END;
CREATE TRIGGER storage_reservations_count_insert AFTER INSERT ON storage_reservations
BEGIN
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','all',1*NEW.bytes WHERE 1 ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','upload',1*NEW.bytes WHERE NEW.category='upload' ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'user',NEW.user_id,1*NEW.bytes WHERE NEW.user_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'project',NEW.project_id,1*NEW.bytes WHERE NEW.project_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER storage_reservations_count_delete AFTER DELETE ON storage_reservations
BEGIN
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='platform' AND scope_id='upload' AND OLD.category='upload';
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='user' AND scope_id=OLD.user_id AND OLD.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='project' AND scope_id=OLD.project_id AND OLD.project_id IS NOT NULL;
END;
CREATE TRIGGER storage_reservations_count_update AFTER UPDATE OF bytes ON storage_reservations
BEGIN
 UPDATE storage_counters SET bytes=bytes+NEW.bytes-OLD.bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes+NEW.bytes-OLD.bytes WHERE scope='platform' AND scope_id='upload' AND NEW.category='upload';
 UPDATE storage_counters SET bytes=bytes+NEW.bytes-OLD.bytes WHERE scope='user' AND scope_id=NEW.user_id AND NEW.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes+NEW.bytes-OLD.bytes WHERE scope='project' AND scope_id=NEW.project_id AND NEW.project_id IS NOT NULL;
END;
