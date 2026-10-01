-- Additive notification history and transactional push outbox. No existing data changes.
CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK (in_app_enabled IN (0,1)),
  push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (push_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','ticket')),
  resource_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE notification_inbox (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (event_id,user_id)
);
CREATE INDEX notification_inbox_user ON notification_inbox(user_id,event_id);
CREATE INDEX notification_events_created ON notification_events(created_at DESC,id DESC);
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  disabled_reason TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id,disabled_at);
CREATE TABLE notification_push_outbox (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id,subscription_id)
);
CREATE INDEX notification_push_due ON notification_push_outbox(status,available_at,lease_until);
