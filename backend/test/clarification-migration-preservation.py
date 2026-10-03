"""Verify the clarification migration against populated SQLite without touching cloud data."""
from pathlib import Path
import sqlite3
root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration.name >= '0039_ai_clarifications.sql':
        break
    db.executescript(migration.read_text())
now='2026-10-03T08:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('fixture-user','migration@invalid.test','Fixture',?)",(now,))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('fixture-project','Keep project','fixture-user',?,?)",(now,now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('fixture-member','fixture-project','fixture-user','owner',?)",(now,))
db.execute("INSERT INTO tasks(id,project_id,title,status,created_by,created_at,updated_at) VALUES('fixture-task','fixture-project','Keep task','todo','fixture-user',?,?)",(now,now))
db.execute("INSERT INTO project_creation_drafts(id,owner_id,payload_json,preview_json,preview_revision,preview_state,preview_attempt_id,project_id,created_at,updated_at) VALUES('fixture-draft','fixture-user','{\"name\":\"Keep draft\"}','{\"tasks\":[]}',1,'ready','fixture-attempt','future-project',?,?)",(now,now))
db.execute("INSERT INTO creation_draft_files(id,draft_id,name,ext,r2_key,sha256,size_bytes,mime,pages_json,created_at) VALUES('fixture-file','fixture-draft','keep.txt','.txt','fixture/key','digest',4,'text/plain','[\"keep\"]',?)",(now,))
db.execute("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES('fixture-job','fixture-project','agent_run','succeeded','{}',?,?)",(now,now))
snapshots={}
for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
    columns=','.join('"'+row[1]+'"' for row in db.execute(f'PRAGMA table_info("{table}")'))
    snapshots[table]=(columns,db.execute(f'SELECT {columns} FROM "{table}" ORDER BY rowid').fetchall())
assert not db.execute('PRAGMA foreign_key_check').fetchall()
db.executescript((root/'migrations/0039_ai_clarifications.sql').read_text())
for table,(columns,before) in snapshots.items():
    assert db.execute(f'SELECT {columns} FROM "{table}" ORDER BY rowid').fetchall()==before,table
assert db.execute("SELECT preview_waiting_id,preview_config_version_id FROM project_creation_drafts WHERE id='fixture-draft'").fetchone()==(None,None)
assert not db.execute('PRAGMA foreign_key_check').fetchall()
print(f'PASS: preserved every existing row/column across {len(snapshots)} tables, including draft preview, files, project, tasks and jobs; foreign keys intact')
