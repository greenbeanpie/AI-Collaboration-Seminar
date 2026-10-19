-- Reuse the durable notification outbox and its existing delivery/revocation flow.
ALTER TABLE push_subscriptions ADD COLUMN transport TEXT NOT NULL DEFAULT 'webpush' CHECK(transport IN ('webpush','fcm'));
ALTER TABLE push_subscriptions ADD COLUMN installation_id TEXT;
ALTER TABLE push_subscriptions ADD COLUMN native_token TEXT;
CREATE UNIQUE INDEX push_native_installation ON push_subscriptions(user_id,installation_id) WHERE transport='fcm';
CREATE INDEX push_native_token ON push_subscriptions(native_token) WHERE transport='fcm';
