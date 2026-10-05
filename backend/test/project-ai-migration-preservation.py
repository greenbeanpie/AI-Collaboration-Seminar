"""Additive project-assistant migration check against populated local SQLite only."""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted((root / "migrations").glob("*.sql")):
    if migration.name >= "0021_project_ai_collaboration.sql":
        break
    db.executescript(migration.read_text())
now = "2026-10-01T00:00:00.000Z"
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','fixture@invalid.test','Fixture',?)", (now,))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at,assignment_mode,evaluation_mode,collaboration_revision) VALUES('project','Retain','owner',?,?,'automatic','manual',7)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('member','project','owner','owner',?)", (now,))
db.execute("INSERT INTO tasks(id,project_id,title,assignee_id,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,current_submission_id) VALUES('task','project','Retain','owner','done',4,'owner',?,?,'accepted','Immutable criteria','submission')", (now, now))
db.execute("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,criteria,task_revision,status,ai_report_json,revision,created_at,updated_at) VALUES('submission','project','task',1,'owner','Immutable body','Immutable criteria',3,'accept','{\"feedback\":\"Retained AI report\"}',2,?,?)", (now, now))
db.execute("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES('file','project','owner','project/original.txt','.txt','available',?)", (now,))
db.execute("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES('source','project','file','Original','owner',?,?)", (now, now))
db.execute("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,text_r2_key,status,created_at) VALUES('version','source','project',1,'file','file','project/text','ready',?)", (now,))
db.execute("UPDATE sources SET current_version_id='version' WHERE id='source'")
tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
snapshots = {}
for table in tables:
    columns = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
    selection = ",".join(f'"{column}"' for column in columns)
    snapshots[table] = (selection, list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid')))
assert not list(db.execute("PRAGMA foreign_key_check"))
db.executescript((root / "migrations/0021_project_ai_collaboration.sql").read_text())
for table, (selection, before) in snapshots.items():
    assert list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid')) == before, f"Existing values changed in {table}"
assert db.execute("SELECT ai_collaboration_enabled,assignment_mode,evaluation_mode,collaboration_revision FROM projects WHERE id='project'").fetchone() == (0, "automatic", "manual", 7)
assert db.execute("SELECT human_score_override_json,ai_report_json,revision,status FROM task_submissions WHERE id='submission'").fetchone() == (None, '{"feedback":"Retained AI report"}', 2, "accept")
assert not list(db.execute("PRAGMA foreign_key_check"))
print(f"PASS: all old columns/rows across {len(tables)} tables preserved; originals, task/report history, modes and budget retained; new project switch off; foreign keys intact")
