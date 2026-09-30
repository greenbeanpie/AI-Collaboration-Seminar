-- Additive password identities: preserve users IDs and every existing project FK.
CREATE TABLE auth_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT,
  username_norm TEXT UNIQUE,
  contact_email TEXT,
  contact_email_norm TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL
);
-- Existing users retain their real contact information, but require an explicit password setup.
-- Ambiguous case-insensitive legacy emails remain contacts, never a login identity.
INSERT INTO auth_accounts (user_id, contact_email, contact_email_norm, created_at)
 SELECT u.id, u.email,
   CASE WHEN (SELECT COUNT(*) FROM users other WHERE lower(trim(other.email)) = lower(trim(u.email))) = 1 THEN lower(trim(u.email)) ELSE NULL END,
   u.created_at FROM users u;
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy' CHECK (auth_method IN ('legacy', 'password'));
CREATE TABLE account_invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id)
);
CREATE TABLE auth_password_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
