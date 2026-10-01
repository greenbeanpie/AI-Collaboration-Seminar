"""Local, in-memory populated-schema preservation check. No production access."""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted((root / "migrations").glob("*.sql")):
    if migration.name >= "0015_collaboration_lifecycle.sql":
        break
    db.executescript(migration.read_text())
now = "2026-10-01T00:00:00.000Z"
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@fixture.invalid','Fixture',?)", (now,))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('project','Preserve','owner',?,?)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('membership','project','owner','owner',?)", (now,))
db.execute("INSERT INTO tasks(id,project_id,title,assignee_id,status,revision,created_by,created_at,updated_at) VALUES('task','project','Retain','owner','done',7,'owner',?,?)", (now, now))
db.execute("INSERT INTO materials(id,project_id,title,current_version_id,revision,created_by,created_at,updated_at) VALUES('material','project','Retain','version',3,'owner',?,?)", (now, now))
db.execute("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES('version','material','project',3,'{}','Immutable retained text','manual','owner',?,'[]')", (now,))
db.execute("INSERT INTO comments(id,project_id,target_type,target_id,author_id,body,created_at) VALUES('comment','project','task','task','owner','Retain comment',?)", (now,))
db.execute("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES('job','project','agent_run','succeeded','{}',1,'owner',?,?)", (now, now))
db.execute("INSERT INTO job_outbox(id,job_id,status,available_at,attempts,created_at,updated_at) VALUES('outbox','job','done',?,1,?,?)", (now, now, now))
db.execute("INSERT INTO usage_reservations(id,project_id,job_id,purpose,estimated_cost,status,created_at,attempts_started) VALUES('reservation','project','job','agent_run',0.02,'pending_reconcile',?,1)", (now,))
db.execute("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) VALUES('event','project','user','owner','fixture','task','task','preserve','{}',?)", (now,))
db.execute("INSERT INTO task_links(id,task_id,project_id,kind,target_id,created_at) VALUES('link','task','project','material','material',?)", (now,))

tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
snapshots = {}
for table in tables:
    columns = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
    selection = ",".join(f'"{col}"' for col in columns)
    snapshots[table] = (selection, list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid')))
assert not list(db.execute("PRAGMA foreign_key_check"))
db.executescript((root / "migrations/0015_collaboration_lifecycle.sql").read_text())
for table, (selection, before) in snapshots.items():
    after = list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid'))
    assert after == before, f"Prior values changed in {table}"
assert not list(db.execute("PRAGMA foreign_key_check")), "Foreign key damage"
assert db.execute("SELECT assignment_mode,evaluation_mode,collaboration_revision FROM projects WHERE id='project'").fetchone() == ("manual", "manual", 1)
assert db.execute("SELECT lifecycle_state,status,revision FROM tasks WHERE id='task'").fetchone() == (None, "done", 7)
assert db.execute("SELECT major FROM project_members WHERE id='membership'").fetchone() == ("",)
assert db.execute("SELECT COUNT(*) FROM task_submissions").fetchone()[0] == 0
assert db.execute("SELECT COUNT(*) FROM collaboration_proposals").fetchone()[0] == 0
print(f"PASS: all prior columns/rows across {len(tables)} populated/seed tables retained; foreign keys intact; manual defaults; no lifecycle retrofit")
