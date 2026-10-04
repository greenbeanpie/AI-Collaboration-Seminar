"""Exercise standard activation on populated legacy SQLite, without cloud access."""
from pathlib import Path
import json
import sqlite3

root = Path(__file__).resolve().parents[1]
migration = root / 'backend/migrations/0044_saved_standard_activation.sql'
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for path in sorted((root / 'backend/migrations').glob('*.sql')):
    if path == migration:
        break
    db.executescript(path.read_text(encoding='utf-8-sig'))
now = '2026-10-03T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@test','Owner',?)", (now,))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('project','Original project','owner',?,?)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('member','project','owner','owner',?)", (now,))
original = None
for number, state in [(1, 'confirmed'), (2, 'draft')]:
    sid, rid, qid, std = f'set{number}', f'rubric{number}', f'requirement{number}', f'standard{number}'
    weights = [{'key': 'quality', 'label': 'Quality', 'weight': 100}]
    db.execute("INSERT INTO requirement_sets(id,project_id,status,revision,created_at,updated_at) VALUES(?,'project',?,7,?,?)", (sid, state, now, now))
    db.execute("INSERT INTO requirements(id,project_id,requirement_set_id,seq,title,detail,category,field_state,updated_at) VALUES(?,'project',?,1,?,'Original detail','deliverable',?,?)", (qid, sid, qid, 'confirmed' if number == 1 else 'edited', now))
    db.execute("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,notes,status,created_at) VALUES(?,'project',?,'custom',?,'Original rules',?,?)", (rid, number, json.dumps(weights), state, now))
    snapshot = {'standardsVersionId': std, 'projectId': 'project', 'version': number, 'title': std, 'requirementSetIds': [sid], 'rubricVersionId': rid, 'mappings': [{'requirementId': qid, 'dimensionKey': 'quality'}], 'requirements': [{'requirementId': qid, 'requirementSetId': sid, 'title': qid, 'detail': 'Original detail', 'category': 'deliverable', 'dueDate': None, 'duePrecision': 'unknown', 'citations': []}], 'rubric': {'rubricVersionId': rid, 'version': number, 'weights': weights, 'notes': 'Original rules'}}
    raw = json.dumps(snapshot) if number == 1 else None
    original = raw if number == 1 else original
    db.execute("INSERT INTO standards_versions(id,project_id,version,title,status,requirement_set_ids_json,rubric_version_id,mappings_json,snapshot_json,revision,created_at,updated_at) VALUES(?,'project',?,?,?,?,?,?,?,9,?,?)", (std, number, std, state, json.dumps([sid]), rid, json.dumps(snapshot['mappings']), raw, now, now))
db.execute("INSERT INTO tasks(id,project_id,title,status,lifecycle_state,criteria,revision,created_by,created_at,updated_at) VALUES('task','project','Original task','doing','submitted','Original criterion',4,'owner',?,?)", (now, now))
db.execute("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,criteria,task_revision,status,ai_report_json,created_at,updated_at) VALUES('submission','project','task',1,'owner','Original result','Original criterion',4,'pending','{\"original\":true}',?,?)", (now, now))
before = {table: db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() for table in ['tasks', 'task_submissions', 'project_members', 'projects']}
requirements = db.execute('SELECT id,title,detail,citations_json,updated_at FROM requirements ORDER BY id').fetchall()
rubrics = db.execute('SELECT id,weights_json,notes,created_at FROM rubric_versions ORDER BY id').fetchall()
db.commit()
db.executescript(migration.read_text(encoding='utf-8-sig'))
assert db.execute("SELECT snapshot_json FROM standards_versions WHERE id='standard1'").fetchone()[0] == original
current = json.loads(db.execute("SELECT snapshot_json FROM standards_versions WHERE id='standard2'").fetchone()[0])
assert current == snapshot
assert db.execute('SELECT id FROM standards_versions ORDER BY version DESC LIMIT 1').fetchone()[0] == 'standard2'
assert db.execute('SELECT id,title,detail,citations_json,updated_at FROM requirements ORDER BY id').fetchall() == requirements
assert db.execute('SELECT id,weights_json,notes,created_at FROM rubric_versions ORDER BY id').fetchall() == rubrics
for table, rows in before.items():
    assert db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() == rows
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print('SAVED-STANDARD-ACTIVATION-MIGRATION-PRESERVATION-PASS')
