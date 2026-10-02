-- Attribution survives membership removal. Existing files remain unmarked.
CREATE TABLE file_contributors (
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 PRIMARY KEY (file_id, user_id)
);
