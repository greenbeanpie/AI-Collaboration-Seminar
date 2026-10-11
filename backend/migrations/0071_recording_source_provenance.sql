-- Existing explicit sources remain discoverable when reused by a recording.
-- Only future automatically created source bindings are marked as such.
ALTER TABLE sources ADD COLUMN automatic_import INTEGER NOT NULL DEFAULT 0 CHECK(automatic_import IN (0,1));
