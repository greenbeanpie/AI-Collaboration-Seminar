"""Apply the new migration to populated legacy data and verify identities/history."""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
for path in sorted((root / 'migrations').glob('*.sql')):
    if path.name >= '0025':
        break
    db.executescript(path.read_text(encoding='utf-8'))
now = '2026-10-02T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@test','Owner',?)", (now,))
db.execute("INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES('project','Project','Original background','owner',?,?)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('member','project','owner','owner',?)", (now,))
for task_id, parent, status, lifecycle in [('completed', None, 'done', None), ('group-a', None, 'todo', 'open'), ('group-b', None, 'todo', 'open'), ('submitted', 'group-a', 'doing', 'submitted')]:
    db.execute("INSERT INTO tasks(id,project_id,title,status,lifecycle_state,parent_task_id,criteria,revision,created_by,created_at,updated_at) VALUES(?,'project',?,?,?,?, 'Original criteria',7,'owner',?,?)", (task_id, task_id, status, lifecycle, parent, now, now))
db.execute("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,created_at,updated_at) VALUES('submission','project','submitted',1,'owner','Original submission','[]','Original criteria',7,?,?)", (now, now))
db.execute("UPDATE tasks SET current_submission_id='submission' WHERE id='submitted'")
db.execute("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES('job','project','agent_run','queued','{\"operation\":\"collaboration.decompose\",\"brief\":\"Original input\"}',?,?)", (now, now))
before = {table: db.execute(f'SELECT * FROM {table}').fetchall() for table in ['tasks', 'task_submissions', 'jobs', 'project_members']}
db.executescript((root / 'migrations' / '0025_project_simplification.sql').read_text(encoding='utf-8'))
for table in ['task_submissions', 'jobs', 'project_members']:
    assert db.execute(f'SELECT * FROM {table}').fetchall() == before[table], table
task_columns = [row[1] for row in db.execute('PRAGMA table_info(tasks)')]
original_task_columns = task_columns[:-1]
assert db.execute('SELECT ' + ','.join(original_task_columns) + ' FROM tasks').fetchall() == before['tasks']
assert db.execute('SELECT project_id,title,detail,revision,graph_revision FROM project_goals').fetchall() == [('project', 'Project', 'Original background', 1, 1)]
assert db.execute('SELECT COUNT(*) FROM standards_versions').fetchone()[0] == 0
assert db.execute('SELECT COUNT(*) FROM assessments').fetchone()[0] == 0
assert db.execute('SELECT COUNT(*) FROM task_dependencies').fetchone()[0] == 0
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
try:
    db.execute("INSERT INTO task_dependencies VALUES('project','completed','completed',?)", (now,))
    raise AssertionError('self-dependency should fail')
except sqlite3.IntegrityError:
    pass
print('PROJECT-SIMPLIFICATION-MIGRATION-PRESERVATION-PASS')
