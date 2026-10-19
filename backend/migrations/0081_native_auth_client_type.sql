-- Existing transactions keep their Android callback; no identities or sessions change.
ALTER TABLE native_auth_transactions ADD COLUMN client_type TEXT NOT NULL DEFAULT 'android'
  CHECK (client_type IN ('android', 'windows'));
