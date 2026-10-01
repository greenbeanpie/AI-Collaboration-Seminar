-- Bounded, content-free operational events. Never store prompts, responses or secrets.
CREATE TABLE ai_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size = length(CAST(entry_json AS BLOB)) + 1)
);
