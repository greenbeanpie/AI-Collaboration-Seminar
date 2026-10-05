"""Apply the audio migration to populated legacy media data without changing it."""
from pathlib import Path
import sqlite3
root=Path(__file__).resolve().parents[1]
db=sqlite3.connect(':memory:')
for path in sorted((root/'migrations').glob('*.sql')):
    if path.name >= '0052':
        break
    db.executescript(path.read_text(encoding='utf-8'))
now='2026-10-04T00:00:00Z'
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('owner','owner@test','Owner',?)",(now,))
config=db.execute('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1').fetchone()[0]
db.execute("INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES('draft','owner','{\"name\":\"Private draft\"}','future-project',?,?)",(now,now))
db.execute("INSERT INTO creation_draft_files(id,draft_id,name,ext,r2_key,sha256,size_bytes,mime,created_at) VALUES('file','draft','audio.wav','.wav','private-key','hash',4,'audio/wav',?)",(now,))
db.execute("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES('job',NULL,'agent_run','succeeded','{}','owner',?,?)",(now,now))
db.execute("INSERT INTO media_processing(id,job_id,draft_file_id,config_version_id,stage,created_at,updated_at) VALUES('media','job','file',?,'ready',?,?)",(config,now,now))
db.execute("INSERT INTO media_calls(id,job_id,config_version_id,model,window_start,status,created_at) VALUES('call','job',?,'gemini',0,'ok',?)",(config,now))
tables=['users','projects','project_members','project_creation_drafts','creation_draft_files','jobs','media_processing','media_calls','ai_config_versions','materials','material_versions']
before={table:db.execute(f'SELECT * FROM {table}').fetchall() for table in tables}
db.executescript((root/'migrations/0052_whisper_audio_pipeline.sql').read_text(encoding='utf-8'))
for table in tables:
    assert db.execute(f'SELECT * FROM {table}').fetchall()==before[table],table
assert db.execute('SELECT COUNT(*) FROM audio_pipeline').fetchone()[0]==0
assert db.execute('SELECT COUNT(*) FROM audio_pipeline_calls').fetchone()[0]==0
assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
print('WHISPER-MIGRATION-PRESERVATION-PASS')
