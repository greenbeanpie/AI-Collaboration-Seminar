"""Exercise the real additive password migration against populated legacy schema.
Run: py -3 backend/test/password-migration-preservation.py
Uses an in-memory SQLite database only; never opens a project database.
"""
from pathlib import Path
import sqlite3

migration_dir = Path(__file__).resolve().parents[1] / 'migrations'
with sqlite3.connect(':memory:') as db:
    db.execute('PRAGMA foreign_keys = ON')
    for path in sorted(migration_dir.glob('*.sql')):
        if path.name < '0012_password_accounts.sql':
            db.executescript(path.read_text(encoding='utf-8-sig'))
    now = '2026-09-30T00:00:00.000Z'
    users = [('u-admin', 'zgpride87@outlook.com'), ('u-case1', 'Person@example.test'), ('u-case2', 'person@example.test')]
    for user_id, email in users:
        db.execute('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)', (user_id, email, user_id, now))
    db.execute("INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES ('p-legacy', 'Existing project', 'u-admin', ?, ?)", (now, now))
    db.execute("INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES ('m-legacy', 'p-legacy', 'u-admin', 'owner', ?)", (now,))
    db.execute("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s-legacy', 'u-admin', 'legacy-token-hash', '2030-01-01T00:00:00.000Z', ?)", (now,))
    before_users = db.execute('SELECT * FROM users ORDER BY id').fetchall()
    before_projects = db.execute('SELECT * FROM projects ORDER BY id').fetchall()
    before_members = db.execute('SELECT * FROM project_members ORDER BY id').fetchall()
    db.executescript((migration_dir / '0012_password_accounts.sql').read_text(encoding='utf-8-sig'))
    assert db.execute('SELECT * FROM users ORDER BY id').fetchall() == before_users
    assert db.execute('SELECT * FROM projects ORDER BY id').fetchall() == before_projects
    assert db.execute('SELECT * FROM project_members ORDER BY id').fetchall() == before_members
    assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    assert db.execute("SELECT auth_method FROM sessions WHERE id = 's-legacy'").fetchone() == ('legacy',)
    assert db.execute("SELECT contact_email, password_hash, is_admin FROM auth_accounts WHERE user_id = 'u-admin'").fetchone() == ('zgpride87@outlook.com', None, 0)
    assert db.execute("SELECT COUNT(*) FROM auth_accounts WHERE user_id IN ('u-case1', 'u-case2') AND contact_email_norm IS NULL").fetchone() == (2,)
print('PASS: original user IDs, projects, membership and foreign keys preserved; legacy sessions unprivileged; duplicate-case contacts migrated without collision.')
