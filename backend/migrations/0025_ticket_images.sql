-- Additive: existing tickets retain their content/status and get normal/other defaults.
ALTER TABLE support_tickets ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','urgent'));
ALTER TABLE support_tickets ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('interface','functionality','account','performance','other'));

-- Reserve a slot before R2 writes. Failed uploads can retry the same immutable ID/hash.
CREATE TABLE support_ticket_images (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  created_at TEXT NOT NULL
);
CREATE INDEX support_ticket_images_ticket ON support_ticket_images(ticket_id, created_at, id);
