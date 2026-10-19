-- Additive native authorization; no existing identities or sessions are rewritten.
CREATE TABLE native_auth_transactions (
  id TEXT PRIMARY KEY,
  code_challenge TEXT NOT NULL,
  client_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_session_hash TEXT,
  code_hash TEXT UNIQUE,
  consumed_at TEXT
);
CREATE INDEX idx_native_auth_transactions_expiry ON native_auth_transactions(expires_at);
