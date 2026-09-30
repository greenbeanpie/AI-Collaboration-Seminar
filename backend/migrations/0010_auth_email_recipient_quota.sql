CREATE TABLE auth_email_recipient_usage (
  day TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0),
  PRIMARY KEY (day, email_hash)
);
