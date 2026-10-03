"""Verify retirement against populated legacy SQLite, with foreign keys enabled."""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
retirement = root / 'migrations' / '0043_remove_task_parent.sql'
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration == retirement:
        break
    db.executescript(migration.read_text(encoding='utf-8'))
now = '2026-10-03T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@test','Owner',?)", (now,))
db.execute("INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES('project','Project','Original background','owner',?,?)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('member','project','owner','owner',?)", (now,))
for task_id, parent, status, lifecycle in [('parent', None, 'doing', 'submitted'), ('child', 'parent', 'todo', 'open'), ('dependency', None, 'done', 'accepted')]:
    db.execute("INSERT INTO tasks(id,project_id,title,detail,status,lifecycle_state,parent_task_id,criteria,revision,created_by,created_at,updated_at) VALUES(?,'project',?,'Original detail',?,?,?,'Original criteria',7,'owner',?,?)", (task_id, task_id, status, lifecycle, parent, now, now))
db.execute("INSERT INTO materials(id,project_id,title,created_by,created_at,updated_at) VALUES('material','project','Original material','owner',?,?)", (now, now))
db.execute("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES('version','material','project',1,'{}','Original body','manual','owner',?)", (now,))
db.execute("UPDATE materials SET current_version_id='version' WHERE id='material'")
db.execute("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,created_at,updated_at) VALUES('submission','project','parent',1,'owner','Original submission','[\"version\"]','Original criteria',7,?,?)", (now, now))
db.execute("UPDATE tasks SET current_submission_id='submission' WHERE id='parent'")
db.execute("INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES('project','child','dependency',?)", (now,))
tables = ['task_submissions', 'materials', 'material_versions', 'task_dependencies', 'project_members', 'projects']
before = {table: db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() for table in tables}
columns = [row[1] for row in db.execute('PRAGMA table_info(tasks)') if row[1] != 'parent_task_id']
tasks_before = db.execute('SELECT ' + ','.join(columns) + ' FROM tasks ORDER BY id').fetchall()
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
db.commit()
db.executescript(retirement.read_text(encoding='utf-8'))
assert 'parent_task_id' not in [row[1] for row in db.execute('PRAGMA table_info(tasks)')]
assert db.execute('SELECT ' + ','.join(columns) + ' FROM tasks ORDER BY id').fetchall() == tasks_before
for table in tables:
    assert db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() == before[table], table
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
assert db.execute("SELECT task_id,depends_on_task_id FROM task_dependencies").fetchall() == [('child', 'dependency')]
try:
    db.execute("INSERT INTO task_dependencies VALUES('project','child','missing',?)", (now,))
    raise AssertionError('Missing prerequisite must fail foreign key validation')
except sqlite3.IntegrityError:
    pass
print('TASK-PARENT-RETIREMENT-MIGRATION-PRESERVATION-PASS')
