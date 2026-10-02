-- Keep project identities and membership roles; templates are permission presets.
ALTER TABLE project_members ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{"teamManage":false,"taskManage":false,"resourceManage":false,"scoreInitiate":true}' CHECK(json_valid(permissions_json));
ALTER TABLE project_members ADD COLUMN permissions_revision INTEGER NOT NULL DEFAULT 1;
