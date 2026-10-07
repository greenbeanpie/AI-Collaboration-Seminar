"""Check the Office session CHECK rebuild against populated data with FK enforcement."""
from pathlib import Path
import sqlite3
root = Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'migrations').glob('*.sql')):
    if migration.name >= '0061': break
    db.executescript(migration.read_text(encoding='utf-8'))
now = '2026-10-06T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('u','u@test','Owner',?)",(now,))
db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('p','Existing','u',?,?)",(now,now))
db.execute("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES('s','p','paste','Original','v','u',?,?)",(now,now))
db.execute("INSERT INTO source_versions(id,source_id,project_id,revision,origin,created_at) VALUES('v','s','p',1,'paste',?)",(now,))
for i,method,status in [('pdf','browser-pdf','processing'),('docx','browser-docx','partial')]:
    db.execute("INSERT INTO document_parse_sessions(id,source_version_id,project_id,actor_id,lifecycle_version,method,status,next_batch,next_seq,warnings_json,total_pages,processed_pages,created_at,updated_at) VALUES(?,'v','p','u',1,?,?,2,9,'[\"image omitted\"]',2,2,?,?)",(i,method,status,now,now))
    db.execute("INSERT INTO document_parse_batches VALUES(?,0,'retained-digest')",(i,))
    db.execute("INSERT INTO document_parse_pages VALUES(?,1)",(i,))
db.execute("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at,extraction_session_id) VALUES('fragment','v','p',1,1,'text','Retain original text',?,'pdf')",(now,))
db.commit()
tables=['document_parse_sessions','document_parse_batches','document_parse_pages','source_versions','sources','source_fragments','users','projects']
before={t:db.execute(f'SELECT * FROM {t} ORDER BY 1').fetchall() for t in tables}
migration=(root/'migrations/0061_office_document_imports.sql').read_text(encoding='utf-8')
db.executescript('BEGIN;'+migration+'COMMIT;')
for t in tables: assert db.execute(f'SELECT * FROM {t} ORDER BY 1').fetchall()==before[t],t
assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
for child in ['document_parse_batches','document_parse_pages']:
    assert db.execute(f'PRAGMA foreign_key_list({child})').fetchone()[2]=='document_parse_sessions'
    try: db.execute(f"INSERT INTO {child} VALUES('missing',99"+(",'bad')" if child.endswith('batches') else ')'))
    except sqlite3.IntegrityError: pass
    else: raise AssertionError('orphan child accepted')
for ext in ['xlsx','pptx']:
    db.execute("INSERT INTO document_parse_sessions(id,source_version_id,project_id,actor_id,lifecycle_version,method,status,created_at,updated_at) VALUES(?,'v','p','u',1,?,'complete',?,?)",(ext,'browser-'+ext,now,now))
try:
    db.execute("INSERT INTO document_parse_sessions(id,source_version_id,project_id,actor_id,lifecycle_version,method,created_at,updated_at) VALUES('duplicate','v','p','u',1,'browser-xlsx',?,?)",(now,now))
except sqlite3.IntegrityError: pass
else: raise AssertionError('active session uniqueness lost')
print('OFFICE-MIGRATION-PRESERVATION-PASS')
