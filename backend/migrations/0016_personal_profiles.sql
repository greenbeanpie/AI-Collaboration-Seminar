-- Opt-in profiles. No backfill: existing and new accounts remain undiscoverable.
CREATE TABLE personal_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  searchable INTEGER NOT NULL DEFAULT 0 CHECK(searchable IN (0,1)),
  bio TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '',
  preferred_roles TEXT NOT NULL DEFAULT '',
  bio_public INTEGER NOT NULL DEFAULT 0 CHECK(bio_public IN (0,1)),
  major_public INTEGER NOT NULL DEFAULT 0 CHECK(major_public IN (0,1)),
  specialties_public INTEGER NOT NULL DEFAULT 0 CHECK(specialties_public IN (0,1)),
  preferred_roles_public INTEGER NOT NULL DEFAULT 0 CHECK(preferred_roles_public IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
