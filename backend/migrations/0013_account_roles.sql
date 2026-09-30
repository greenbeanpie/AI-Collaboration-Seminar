-- Additive only: preserve IDs, password hashes, sessions, memberships and project data.
-- NULL keeps older bootstrap tooling compatible, mapping is_admin=1 only to ordinary admin.
ALTER TABLE auth_accounts ADD COLUMN account_role TEXT CHECK (account_role IN ('super_admin', 'admin', 'user'));
UPDATE auth_accounts SET account_role = CASE WHEN is_admin = 1 THEN 'admin' ELSE 'user' END;
-- Only the documented existing owner identity is promoted; other admins stay ordinary admins.
UPDATE auth_accounts SET account_role = 'super_admin'
 WHERE user_id = 'f5f71370-f8cf-4fb5-b0b7-d337c36a9711' AND username_norm = 'greenbp' AND contact_email_norm = 'zgpride87@outlook.com'
   AND is_admin = 1 AND length(trim(COALESCE(username, ''))) > 0 AND length(trim(COALESCE(password_hash, ''))) > 0;
CREATE TABLE account_role_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
