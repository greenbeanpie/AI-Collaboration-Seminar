"""Verify additive migration against a pre-upgrade SQLite DB with real-shaped identities."""
import pathlib, sqlite3
root = pathlib.Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
for path in sorted((root / 'migrations').glob('*.sql')):
    if path.name >= '0013': break
    db.executescript(path.read_text())
for id, username, email, admin in [('f5f71370-f8cf-4fb5-b0b7-d337c36a9711', 'greenbp', 'zgpride87@outlook.com', 1), ('admin', 'other', 'other@example.test', 1), ('user', 'regular', 'regular@example.test', 0)]:
    db.execute('INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)', (id,email,id,'2026-09-30'))
    db.execute('INSERT INTO auth_accounts (user_id,username,username_norm,contact_email_norm,is_admin,password_hash,created_at) VALUES (?,?,?,?,?,?,?)', (id,username,username,email,admin,'untouched-'+id,'2026-09-30'))
db.execute("INSERT INTO projects (id,name,description,status,revision,created_by,created_at,updated_at) VALUES ('kept-project','kept','', 'active',1,'f5f71370-f8cf-4fb5-b0b7-d337c36a9711','2026-09-30','2026-09-30')")
db.execute("INSERT INTO project_members (id,project_id,user_id,role,joined_at) VALUES ('kept-membership','kept-project','f5f71370-f8cf-4fb5-b0b7-d337c36a9711','owner','2026-09-30')")
db.execute("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,auth_method) VALUES ('kept-session','f5f71370-f8cf-4fb5-b0b7-d337c36a9711','fixture-session-hash','2099-01-01','2026-09-30','password')")
before = db.execute('SELECT user_id,password_hash FROM auth_accounts ORDER BY user_id').fetchall()
kept = {table: db.execute(f'SELECT * FROM {table}').fetchall() for table in ['users','projects','project_members','sessions']}
db.executescript((root / 'migrations/0013_account_roles.sql').read_text())
assert before == db.execute('SELECT user_id,password_hash FROM auth_accounts ORDER BY user_id').fetchall()
assert dict(db.execute('SELECT user_id,account_role FROM auth_accounts')) == {'f5f71370-f8cf-4fb5-b0b7-d337c36a9711':'super_admin','admin':'admin','user':'user'}
db.executescript((root / 'migrations/0014_support_tickets.sql').read_text())
assert db.execute('SELECT COUNT(*) FROM support_tickets').fetchone()[0] == 0
for table, rows in kept.items():
    assert rows == db.execute(f'SELECT * FROM {table}').fetchall(), table
print('PASS: exact owner-only promotion; credentials, identities, sessions, projects and memberships unchanged')
