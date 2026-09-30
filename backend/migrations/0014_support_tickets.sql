-- Text-only support records; independent of project membership and invitation systems.
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX support_tickets_owner_created ON support_tickets(owner_id, created_at DESC, id DESC);
CREATE INDEX support_tickets_created ON support_tickets(created_at DESC, id DESC);
CREATE TABLE support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('reply','status')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX support_ticket_messages_ticket_created ON support_ticket_messages(ticket_id, created_at, id);
