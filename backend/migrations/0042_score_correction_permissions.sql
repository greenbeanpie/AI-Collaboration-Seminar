-- Preserve existing permission values; ordinary members receive no correction grant.
UPDATE project_members SET permissions_json=json_set(COALESCE(permissions_json,'{}'),'$.scoreCorrect',json('false')) WHERE json_extract(COALESCE(permissions_json,'{}'),'$.scoreCorrect') IS NULL;
ALTER TABLE rehearsals ADD COLUMN reference_inputs_json TEXT NOT NULL DEFAULT '{}';
