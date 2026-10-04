"""Exercise additive migration/backfill on populated legacy SQLite data."""
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration.name >= '0046':
        break
    db.executescript(migration.read_text(encoding='utf-8'))
now = '2026-10-04T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@test','Owner',?)", (now,))
db.execute("INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES('project','Project','Existing description','owner',?,?)", (now, now))
db.execute("INSERT INTO project_goals(project_id,title,detail,created_at,updated_at) VALUES('project','Existing goal','Existing goal detail',?,?)", (now, now))
db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('member','project','owner','owner',?)", (now,))
db.execute("INSERT INTO materials(id,project_id,title,purpose,is_default_background,current_version_id,revision,created_by,created_at,updated_at) VALUES('legacy','project','Edited background','background',1,'legacy-v1',1,'owner',?,?)", (now, now))
db.execute("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES('legacy-v1','legacy','project',1,'{}','Retain manual edits','manual','owner',?)", (now,))
db.commit()
tables = ['projects', 'project_goals', 'project_members', 'material_versions']
before = {table: db.execute(f'SELECT * FROM {table}').fetchall() for table in tables}
materials_before = db.execute('SELECT * FROM materials').fetchall()
db.executescript((root / 'migrations/0046_system_background.sql').read_text(encoding='utf-8'))
for table in tables:
    assert db.execute(f'SELECT * FROM {table}').fetchall() == before[table], table
assert [row[:-1] for row in db.execute('SELECT * FROM materials')] == materials_before
db.execute('UPDATE project_goals SET title=title')
system = db.execute('SELECT id,current_version_id,revision FROM materials WHERE system_managed=1').fetchone()
assert system and system[2] == 1
assert db.execute('SELECT markdown FROM material_versions WHERE id=?', (system[1],)).fetchone()[0].endswith('Existing goal detail')
db.execute('UPDATE project_goals SET title=title')
assert db.execute('SELECT id,current_version_id,revision FROM materials WHERE system_managed=1').fetchone() == system
assert db.execute("SELECT markdown FROM material_versions WHERE id='legacy-v1'").fetchone()[0] == 'Retain manual edits'
db.commit()
db.execute("UPDATE project_goals SET title='Updated goal'")
assert db.execute('SELECT revision FROM materials WHERE system_managed=1').fetchone()[0] == 2
db.rollback()
assert db.execute('SELECT id,current_version_id,revision FROM materials WHERE system_managed=1').fetchone() == system
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
print('SYSTEM-BACKGROUND-MIGRATION-PRESERVATION-PASS')
