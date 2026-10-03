"""Read-only checks against source paths and an empty in-memory schema.

Never connects to a cloud database or applies migrations to an existing database.
"""
from pathlib import Path
import hashlib
import json
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
HELP = ROOT / 'frontend/src/help'
manual = (HELP / 'TECHNICAL-IMPLEMENTATION.md').read_text(encoding='utf-8-sig')
dictionary = (HELP / 'DATABASE-SCHEMA.md').read_text(encoding='utf-8-sig')
missing_paths = []
paths = set(re.findall(r'`((?:backend|frontend|shared|scripts|deploy)/[^`\s]+)`', manual + dictionary))
for reference in paths:
    candidate = reference.split(':')[0].split('#')[0].rstrip('.,;')
    if '*' in candidate:
        exists = any(ROOT.glob(candidate))
    else:
        exists = (ROOT / candidate).exists()
    if not exists:
        missing_paths.append(reference)
assert not missing_paths, f'Documentation refers to missing source paths: {missing_paths}'

db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
skipped = {'0002_seed.sql'}
migrations = []
for migration in sorted((ROOT / 'backend/migrations').glob('*.sql')):
    status = 'skipped' if migration.name in skipped else 'applied'
    if status == 'applied':
        db.executescript(migration.read_text(encoding='utf-8-sig'))
    migrations.append({'name': migration.name, 'status': status, 'sha256': hashlib.sha256(migration.read_bytes()).hexdigest()})
tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
documented_tables = set(re.findall(r'^## `([a-z_]+)`\s*$', dictionary, re.M))
assert tables == documented_tables, f'Missing tables: {tables - documented_tables}; extra tables: {documented_tables - tables}'

# The published DDL is also executable, rather than illustrative pseudocode.
ddl_db = sqlite3.connect(':memory:')
ddl_db.execute('PRAGMA foreign_keys=ON')
for sql in re.findall(r'^```sql\n(.*?)\n```\s*$', dictionary.replace('\r', ''), re.M | re.S):
    ddl_db.executescript(sql)
comparison = []
for table in sorted(tables):
    columns = db.execute(f'PRAGMA table_info("{table}")').fetchall()
    rendered_columns = ddl_db.execute(f'PRAGMA table_info("{table}")').fetchall()
    assert columns == rendered_columns, f'DDL column mismatch: {table}'
    block = re.split(r'^## ', dictionary, flags=re.M)[1:]
    block = next(part for part in block if part.startswith(f'`{table}`\n'))
    for column in columns:
        assert re.search(r'^\| `' + re.escape(column[1]) + r'` \|', block, re.M), f'Missing column description: {table}.{column[1]}'
    for pragma in ['foreign_key_list', 'index_list']:
        expected = db.execute(f'PRAGMA {pragma}("{table}")').fetchall()
        actual = ddl_db.execute(f'PRAGMA {pragma}("{table}")').fetchall()
        if pragma == 'index_list':
            # SQLite's display sequence depends on creation order, not index semantics.
            expected = [row[1:] for row in expected]
            actual = [row[1:] for row in actual]
        assert sorted(expected) == sorted(actual), f'{pragma} mismatch: {table}'
    for index in db.execute(f'PRAGMA index_list("{table}")'):
        name = index[1]
        assert db.execute(f'PRAGMA index_info("{name}")').fetchall() == ddl_db.execute(f'PRAGMA index_info("{name}")').fetchall(), f'Index columns mismatch: {name}'
        assert db.execute('SELECT sql FROM sqlite_master WHERE name=?', (name,)).fetchone() == ddl_db.execute('SELECT sql FROM sqlite_master WHERE name=?', (name,)).fetchone(), f'Index DDL mismatch: {name}'
    comparison.append({'table': table, 'columns': len(columns), 'ddlMatchesMigrations': True})
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
for name, kind, sql in db.execute("SELECT name,type,sql FROM sqlite_master WHERE type IN ('view','trigger')"):
    assert ddl_db.execute('SELECT type,sql FROM sqlite_master WHERE name=?', (name,)).fetchone() == (kind, sql), f'View or trigger DDL mismatch: {name}'
sql_examples = 0
for block in re.findall(r'^```sql\n(.*?)\n```\s*$', manual.replace('\r', ''), re.M | re.S):
    for statement in block.split(';'):
        if statement.strip():
            assert statement.strip().upper().startswith('SELECT'), 'Handover investigation examples must be read-only'
            db.execute('EXPLAIN ' + statement).fetchall()
            sql_examples += 1

symbols = {
    'backend/src/app.ts': ['createApp'],
    'backend/src/services/jobs.ts': ['createJobAndDispatch', 'tryDispatchJob', 'reconcileWorkflowJob'],
    'backend/src/workflows/ai-job.ts': ['AgentRunWorkflow'],
    'backend/src/services/ai-jobs.ts': ['runAiJob'],
    'backend/src/services/ai-execution-slices.ts': ['executeAiSlice', 'continueExecutionSlice'],
    'backend/src/services/project-ai-tools.ts': ['projectToolConversation', 'assertToolAccess'],
    'backend/src/services/project-investigation.ts': ['InvestigationContinuation', 'loadInvestigation', 'saveInvestigation'],
    'backend/src/ai/gateway.ts': ['gatewayChat'],
    'backend/src/ai/transport.ts': ['buildProviderRequest', 'normalizeProviderResponse'],
}
for filename, names in symbols.items():
    source = (ROOT / filename).read_text(encoding='utf-8-sig')
    for name in names:
        assert name in source and name in manual, f'Missing chain reference: {filename}:{name}'
for value in [manual, dictionary]:
    assert len(re.findall(r'^```', value, re.M)) % 2 == 0, 'Unclosed code fence'

report = {'scope': 'read-only source and in-memory SQLite checks', 'sourcePathsChecked': len(paths), 'tableCount': len(tables), 'columnCount': sum(item['columns'] for item in comparison), 'ddlAndMetadataMatch': True, 'integrityCheck': 'ok', 'foreignKeyCheck': [], 'migrations': migrations, 'tables': comparison, 'aiChainSymbolsChecked': sum(map(len, symbols.values())), 'readOnlySqlExamplesChecked': sql_examples}
output = ROOT / 'docs/evidence/help/handover'
output.mkdir(parents=True, exist_ok=True)
(output / 'document-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in report.items() if key not in {'tables', 'migrations'}}, ensure_ascii=False))
