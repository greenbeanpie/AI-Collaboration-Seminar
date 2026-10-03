"""Verify 0040-0042 against populated legacy tables, preserving deployed manual ledger."""
from pathlib import Path
import json
import sqlite3

root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration.name.startswith('0040'):
        break
    if migration.name.startswith('0033'):
        continue
    db.executescript(migration.read_text(encoding='utf-8'))
now = '2026-10-03T08:00:00Z'
for user in ['owner', 'member']:
    db.execute('INSERT INTO users(id,email,display_name,created_at) VALUES(?,?,?,?)', (user, user+'@invalid.test', user, now))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('p','Retain','owner',?,?)", (now,now))
permissions = {'teamManage': True, 'taskManage': False, 'resourceManage': True, 'scoreInitiate': True}
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at,permissions_json,permissions_revision) VALUES('m','p','member','member',?,?,3)", (now,json.dumps(permissions)))
for task, status, lifecycle, assignee in [('open','todo','open',None),('started','doing','in_progress','member')]:
    db.execute('INSERT INTO tasks(id,project_id,title,status,lifecycle_state,assignee_id,created_by,created_at,updated_at) VALUES(?,\'p\',?,?,?, ?,\'owner\',?,?)', (task,task,status,lifecycle,assignee,now,now))
for feedback, scope in [('Persistent','project'),('Scoped','task')]:
    db.execute('INSERT INTO project_admin_feedback(id,project_id,actor_id,target_type,feedback,created_at) VALUES(?,\'p\',\'owner\',?,?,?)', (scope,scope,feedback,now))
before = {}
for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
    columns = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")') if not (table == 'project_members' and row[1] == 'permissions_json')]
    selection = ','.join('"'+column+'"' for column in columns)
    before[table] = (selection, db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid').fetchall())
for name in ['0040_invitation_task_approval.sql','0041_project_feedback_versions.sql','0042_score_correction_permissions.sql']:
    db.executescript((root/'migrations'/name).read_text(encoding='utf-8'))
for table, (selection, rows) in before.items():
    assert db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid').fetchall() == rows, table
after = json.loads(db.execute("SELECT permissions_json FROM project_members WHERE id='m'").fetchone()[0])
assert all(after[key] == value for key,value in permissions.items())
assert after['scoreCorrect'] is False
assert db.execute("SELECT started_at FROM tasks WHERE id='open'").fetchone()[0] is None
assert db.execute("SELECT started_at FROM tasks WHERE id='started'").fetchone()[0] == now
db.execute("UPDATE tasks SET status='todo',lifecycle_state='open',assignee_id=NULL WHERE id='started'")
assert db.execute("SELECT started_at FROM tasks WHERE id='started'").fetchone()[0] == now
assert db.execute('SELECT feedback FROM project_feedback_versions').fetchone()[0] == 'Persistent'
assert db.execute('SELECT COUNT(*) FROM project_admin_feedback').fetchone()[0] == 2
assert not db.execute('PRAGMA foreign_key_check').fetchall()
print(f'PASS: 0040-0042 preserve old columns/rows in {len(before)} tables; prior grants retained, corrections denied by default, start history permanent, feedback scopes preserved, foreign keys intact')
