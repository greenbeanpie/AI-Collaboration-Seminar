"""Restore an ignored D1 business-table dump locally and verify the additive migration.
Usage: python verify-task-file-backup.py dump.sql virtual-indexes.json migration.sql auxiliary-schema.json
Only aggregate counts and hashes are printed; database rows remain private.
"""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

dump, virtual_metadata, migration = map(Path, sys.argv[1:4])
db = sqlite3.connect(':memory:')
for table in json.loads(virtual_metadata.read_text(encoding='utf-8-sig')):
    db.executescript(table['sql'] + ';')
db.executescript(dump.read_text(encoding='utf-8-sig'))
auxiliary = json.loads(Path(sys.argv[4]).read_text(encoding='utf-8-sig'))
for result in auxiliary:
    for definition in result.get('results', []):
        if not db.execute('SELECT 1 FROM sqlite_master WHERE name=?', (definition['name'],)).fetchone():
            db.executescript(definition['sql'] + ';')
# FTS5 is derived from the backed-up resource_index_blocks. Rebuild rather than retain shadow tables.
db.execute('DELETE FROM resource_index_fts')
db.execute('INSERT INTO resource_index_fts(rowid,content,block_id) SELECT rowid,search_content,id FROM resource_index_blocks')
db.execute('PRAGMA foreign_keys=ON')
assert not db.execute('PRAGMA foreign_key_check').fetchall(), 'Backup has foreign key violations'
tables = ['files', 'materials', 'material_versions', 'tasks', 'task_submissions']
columns = {table: [row[1] for row in db.execute(f'PRAGMA table_info({table})')] for table in tables}
def digest(table):
    rows = db.execute(f"SELECT {','.join(columns[table])} FROM {table} ORDER BY rowid").fetchall()
    return len(rows), hashlib.sha256(json.dumps(rows, ensure_ascii=False, default=str).encode()).hexdigest()
before = {table: digest(table) for table in tables}
db.executescript(migration.read_text(encoding='utf-8-sig'))
assert before == {table: digest(table) for table in tables}, 'Migration changed original rows'
assert not db.execute('PRAGMA foreign_key_check').fetchall(), 'Migration broke foreign keys'
assert db.execute('SELECT COUNT(*) FROM resource_index_fts').fetchone() == db.execute('SELECT COUNT(*) FROM resource_index_blocks').fetchone()
print(json.dumps({'backupRestored': True, 'migrationPreserved': True, 'foreignKeyViolations': 0, 'virtualIndexesRebuilt': True, 'originalTables': {table: {'rows': value[0], 'sha256': value[1]} for table, value in before.items()}}))
