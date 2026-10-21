"""Rebuild the single handbook dictionary from migrations in an empty in-memory database."""
from pathlib import Path
import argparse
import hashlib
import re
import sqlite3

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys=ON')
for migration in sorted((root / 'backend/migrations').glob('*.sql')):
    if migration.name != '0002_seed.sql':
        db.executescript(migration.read_text(encoding='utf-8-sig'))
tables = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
shadow_tables = {row[1] for row in db.execute('PRAGMA table_list') if row[2] == 'shadow'}
parts = ['# 数据库完整结构字典\n\n本字典由 `scripts/update-handbook-schema.py` 在空的内存 SQLite 中重放 `backend/migrations/*.sql` 后生成，仅跳过演示数据 `0002_seed.sql`。'
         f'当前包含 {len(tables)} 张表（含全文索引影子表）。它描述代码迁移后的目标结构，不代表生产数据库已经应用；不会读取或修改本机或生产数据。'
         '完整约束保留在 DDL，类型、非空、默认值、主键、外键和索引来自实际元数据。\n\n'
         'AI 金额字段仅为历史结构兼容，不代表现行项目预算功能。ID/JSON/时间字段的业务校验仍以服务端契约为准。'
         '字典中的 DDL 仅供说明与空库校验，部署必须按原迁移顺序执行。\n\n[返回技术说明](/app/help?doc=technical)。\n']
for table, ddl in tables:
    quote = table.replace('"', '""')
    columns = db.execute(f'PRAGMA table_info("{quote}")').fetchall()
    parts.append(f'\n## `{table}`\n\n| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |\n| --- | --- | --- | --- | --- |\n')
    for _, name, kind, required, default, primary in columns:
        default = '无' if default is None else str(default).replace('|', '\\|')
        parts.append(f'| `{name}` | {kind} | {"是" if required else "否"} | {default} | {primary or "否"} |\n')
    parts.append('\n外键：\n')
    foreign = db.execute(f'PRAGMA foreign_key_list("{quote}")').fetchall()
    for identity, sequence, target, local, remote, update, delete, match in foreign:
        parts.append(f'- `{local}` → `{target}.{remote}`；ON UPDATE {update}；ON DELETE {delete}；复合关系 {identity}/{sequence}；MATCH {match}。\n')
    if not foreign:
        parts.append('- 无。\n')
    parts.append('\n索引：\n')
    indexes = db.execute(f'PRAGMA index_list("{quote}")').fetchall()
    for _, name, unique, origin, partial in indexes:
        index_quote = name.replace('"', '""')
        fields = ', '.join(str(row[2]) for row in db.execute(f'PRAGMA index_info("{index_quote}")'))
        parts.append(f'- `{name}`：`{fields}`；唯一={unique}；来源={origin}；部分索引={partial}。\n')
    if not indexes:
        parts.append('- 无。\n')
    sql = [ddl.rstrip(';') + ';']
    sql += [row[0].rstrip(';') + ';' for row in db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name", (table,))]
    if table in shadow_tables:
        parts.append('\n此影子表由全文虚拟表自动创建；下列为派生结构说明，不应单独执行。\n\n```text\n' + '\n'.join(sql) + '\n```\n')
    else:
        parts.append('\n```sql\n' + '\n'.join(sql) + '\n```\n')
extra = db.execute("SELECT sql FROM sqlite_master WHERE type IN ('view','trigger') ORDER BY type,name").fetchall()
if extra:
    parts.append('\n## 视图与触发器\n\n```sql\n' + '\n'.join(row[0].rstrip(';') + ';' for row in extra) + '\n```\n')
document = ''.join(parts)
path = root / 'README.md'
source = path.read_text(encoding='utf-8-sig')
start, end = '<!-- help:database:start -->\n', '<!-- help:database:end -->'
assert source.count(start) == source.count(end) == 1
before, rest = source.split(start)
_, after = rest.split(end)
updated = before + start + document + end + after
native_path = root / 'android-native/app/src/main/java/cn/buwei/nativeapp/features/HelpWorkspaceDocuments.kt'
native = native_path.read_text(encoding='utf-8-sig')
for key in ['user', 'technical', 'database']:
    content = updated.split(f'<!-- help:{key}:start -->\n')[1].split(f'<!-- help:{key}:end -->')[0]
    pattern = r'(HelpWorkspaceSource\("' + key + r'"[^\n]*?,")([a-f0-9]{64})(","native-help/)'
    native, count = re.subn(pattern, lambda match: match[1] + hashlib.sha256(content.encode()).hexdigest() + match[3], native)
    assert count == 1, key
if args.check:
    assert updated == source and native == native_path.read_text(encoding='utf-8-sig'), 'Handbook dictionary or native help hashes are stale'
else:
    path.write_text(updated, encoding='utf-8', newline='\n')
    native_path.write_text(native, encoding='utf-8', newline='\n')
print(f'PASS: {len(tables)} migration-derived tables and all three native help digests')
