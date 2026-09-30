CREATE TABLE auth_email_daily_usage (
  day TEXT PRIMARY KEY,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0)
);
