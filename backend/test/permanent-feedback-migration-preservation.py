"""Check additive feedback migration and legacy scope preservation in SQLite."""
from pathlib import Path
import sqlite3
root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root/'migrations').glob('*.sql')):
    if migration.name >= '0041_project_feedback_versions.sql':
        break
    db.executescript(migration.read_text(encoding='utf-8'))
now='2026-10-03T08:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('u','fixture@invalid.test','Fixture',?)",(now,))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('p','Project','u',?,?)",(now,now))
for id,target,text,time in [('f2','project','Second','2026-10-02'),('f1','project','First','2026-10-01'),('f3','task','Task only','2026-10-03')]:
    db.execute('INSERT INTO project_admin_feedback(id,project_id,actor_id,target_type,feedback,created_at) VALUES(?,\'p\',\'u\',?,?,?)',(id,target,text,time))
before={}
for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
    before[table]=db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
db.executescript((root/'migrations/0041_project_feedback_versions.sql').read_text(encoding='utf-8'))
assert db.execute('SELECT version,feedback FROM project_feedback_versions').fetchone()==(1,'First\n\nSecond')
for table,rows in before.items():
    assert db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()==rows,table
assert not db.execute('PRAGMA foreign_key_check').fetchall()
print(f'PASS: every existing row in {len(before)} tables preserved; ordered project feedback imported and task feedback kept in scope')
