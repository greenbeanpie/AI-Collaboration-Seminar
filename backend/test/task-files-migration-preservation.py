"""Verify additive file archival migration on populated legacy SQLite."""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
target = root / 'migrations' / '0055_task_files_archive.sql'
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration == target:
        break
    db.executescript(migration.read_text(encoding='utf-8'))
now = '2026-10-04T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@example.test','Owner',?)", (now,))
db.execute("INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES('project','Original project','Preserved','owner',?,?)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('member','project','owner','owner',?)", (now,))
db.execute("INSERT INTO tasks(id,project_id,title,criteria,status,created_by,created_at,updated_at) VALUES('task','project','Original task','Criteria','doing','owner',?,?)", (now, now))
db.execute("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES('file','project','owner','original/object','.pdf','available','Original.pdf',?)", (now,))
db.execute("INSERT INTO materials(id,project_id,title,current_version_id,created_by,created_at,updated_at) VALUES('material','project','Original material','version','owner',?,?)", (now, now))
db.execute("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,attachments_json,origin,author_id,created_at) VALUES('version','material','project',1,'{}','Original body','[{\"fileId\":\"file\",\"name\":\"Original.pdf\"}]','manual','owner',?)", (now,))
db.execute("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,created_at,updated_at) VALUES('submission','project','task',1,'owner','Original submission','[\"version\"]','Criteria',1,?,?)", (now, now))
tables = ['files', 'materials', 'material_versions', 'tasks', 'task_submissions', 'projects', 'project_members']
columns = {table: [row[1] for row in db.execute(f'PRAGMA table_info({table})')] for table in tables}
before = {table: db.execute(f"SELECT {','.join(columns[table])} FROM {table} ORDER BY rowid").fetchall() for table in tables}
db.commit()
db.executescript(target.read_text(encoding='utf-8'))
for table in tables:
    assert db.execute(f"SELECT {','.join(columns[table])} FROM {table} ORDER BY rowid").fetchall() == before[table], table
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
assert db.execute('SELECT archived_at FROM files').fetchone() == (None,)
assert db.execute('SELECT task_id,archived_at FROM materials').fetchone() == (None, None)
assert db.execute('SELECT COUNT(*) FROM task_file_uploads').fetchone() == (0,)
try:
    db.execute("INSERT INTO task_file_uploads(file_id,material_id) VALUES('missing','material')")
    raise AssertionError('Foreign keys must remain enforced')
except sqlite3.IntegrityError:
    pass
print('TASK-FILES-ARCHIVE-MIGRATION-PRESERVATION-PASS')
