CREATE TABLE auth_email_ip_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_auth_email_ip_attempts ON auth_email_ip_attempts(ip_hash, attempted_at);
