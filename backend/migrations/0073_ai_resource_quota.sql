CREATE TABLE ai_resource_dispatches (
  id TEXT PRIMARY KEY, dispatch_key TEXT NOT NULL UNIQUE, quota_day TEXT NOT NULL,
  user_id TEXT, project_id TEXT, operation TEXT NOT NULL, target_id TEXT, model TEXT,
  status TEXT NOT NULL CHECK(status IN('claimed','completed','uncertain','cancelled')),
  lease_until TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX idx_ai_resource_active ON ai_resource_dispatches(status,lease_until) WHERE status IN('claimed','uncertain');
CREATE TABLE ai_resource_release_audit (
  id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE ai_resource_daily (
  quota_day TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN('user','project','platform')),
  scope_id TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  PRIMARY KEY(quota_day,scope,scope_id)
);
CREATE TRIGGER ai_resource_dispatch_count AFTER INSERT ON ai_resource_dispatches BEGIN
  UPDATE ai_resource_daily SET calls=calls+1 WHERE quota_day=NEW.quota_day AND scope='platform' AND scope_id='global';
  UPDATE ai_resource_daily SET calls=calls+1 WHERE quota_day=NEW.quota_day AND scope='user' AND scope_id=NEW.user_id;
  UPDATE ai_resource_daily SET calls=calls+1 WHERE quota_day=NEW.quota_day AND scope='project' AND scope_id=NEW.project_id;
END;
CREATE TRIGGER ai_resource_cancel_count AFTER UPDATE OF status ON ai_resource_dispatches
WHEN OLD.status='claimed' AND NEW.status='cancelled' BEGIN
  UPDATE ai_resource_daily SET calls=calls-1 WHERE quota_day=NEW.quota_day AND scope='platform' AND scope_id='global';
  UPDATE ai_resource_daily SET calls=calls-1 WHERE quota_day=NEW.quota_day AND scope='user' AND scope_id=NEW.user_id;
  UPDATE ai_resource_daily SET calls=calls-1 WHERE quota_day=NEW.quota_day AND scope='project' AND scope_id=NEW.project_id;
END;
