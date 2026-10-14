-- Lower the ceiling without removing existing objects or modifying historical migrations.
UPDATE resource_policy SET policy_json=json_set(policy_json,
 '$.platformStorageBytes',MIN(json_extract(policy_json,'$.platformStorageBytes'),9000000000),
 '$.projectStorageBytes',MIN(json_extract(policy_json,'$.projectStorageBytes'),json_extract(policy_json,'$.platformStorageBytes'),9000000000),
 '$.userStorageBytes',MIN(json_extract(policy_json,'$.userStorageBytes'),json_extract(policy_json,'$.platformStorageBytes'),9000000000),
 '$.uploadPoolBytes',MIN(json_extract(policy_json,'$.uploadPoolBytes'),7200000000,CAST(MIN(json_extract(policy_json,'$.platformStorageBytes'),9000000000)*0.8 AS INTEGER))),
 version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1;
INSERT INTO resource_policy_audit(id,actor_id,version,policy_json,created_at)
 SELECT 'migration:0077',NULL,version,policy_json,updated_at FROM resource_policy WHERE id=1;
