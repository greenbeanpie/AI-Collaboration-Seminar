CREATE TABLE project_username_invitations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 recipient_id TEXT NOT NULL REFERENCES users(id),
 username TEXT NOT NULL,
 invited_by TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','expired')),
 expires_at TEXT NOT NULL,
 handled_at TEXT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pending_username_invite ON project_username_invitations(project_id,recipient_id) WHERE status='pending';
CREATE INDEX idx_username_invite_recipient ON project_username_invitations(recipient_id,created_at);
