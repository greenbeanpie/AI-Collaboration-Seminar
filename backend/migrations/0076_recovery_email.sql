ALTER TABLE auth_accounts ADD COLUMN recovery_email_version INTEGER NOT NULL DEFAULT 0 CHECK (recovery_email_version >= 0);
ALTER TABLE password_recovery_tokens ADD COLUMN issuance_source TEXT NOT NULL DEFAULT 'admin' CHECK (issuance_source IN ('admin','email'));
ALTER TABLE password_recovery_tokens ADD COLUMN email_fingerprint TEXT;
-- Legacy codes have no binding snapshot; revoke rather than guessing their authority.
UPDATE password_recovery_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE used_at IS NULL;

CREATE TABLE recovery_email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  pending_email TEXT NOT NULL,
  password_fingerprint TEXT NOT NULL,
  email_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  claim_id TEXT
);
CREATE INDEX recovery_email_verification_user ON recovery_email_verifications(user_id,expires_at);

CREATE TABLE auth_email_dispatches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verification','recovery')),
  status TEXT NOT NULL CHECK (status IN ('reserved','sent','failed','unknown')),
  created_at TEXT NOT NULL
);
CREATE INDEX auth_email_dispatch_recipient ON auth_email_dispatches(recipient_hash,created_at);
-- Admission checks and these increments execute inside the same SQLite statement.
CREATE TRIGGER auth_email_dispatch_count AFTER INSERT ON auth_email_dispatches BEGIN
  INSERT INTO auth_email_daily_usage(day,sends) VALUES (NEW.day,1)
    ON CONFLICT(day) DO UPDATE SET sends=sends+1;
  INSERT INTO auth_email_recipient_usage(day,email_hash,sends) VALUES (NEW.day,NEW.recipient_hash,1)
    ON CONFLICT(day,email_hash) DO UPDATE SET sends=sends+1;
END;
