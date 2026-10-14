CREATE TABLE resource_policy (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1,
  policy_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO resource_policy VALUES(1,1,'{"aiEnabled":true,"userDailyCalls":300,"projectDailyCalls":1000,"platformDailyCalls":5000,"globalConcurrency":10,"userStorageBytes":250000000,"projectStorageBytes":1000000000,"platformStorageBytes":10000000000,"uploadPoolBytes":8000000000,"externalStorageBytes":0}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE resource_policy_audit (id TEXT PRIMARY KEY, actor_id TEXT, version INTEGER NOT NULL, policy_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE storage_inventory_state (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN(0,1)), external_checked_at TEXT, updated_at TEXT NOT NULL);
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
