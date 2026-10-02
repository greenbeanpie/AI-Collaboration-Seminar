"""Existing support content, replies, identities and settings survive the additive upgrade."""
import pathlib, sqlite3
root = pathlib.Path(__file__).resolve().parents[1]
db = sqlite3.connect(':memory:')
for path in sorted((root / 'migrations').glob('*.sql')):
    if path.name >= '0025': break
    db.executescript(path.read_text())
db.execute("INSERT INTO users (id,email,display_name,created_at) VALUES ('owner','fixture@example.test','用户','2026-10-01')")
db.execute("INSERT INTO support_tickets (id,owner_id,title,body,status,revision,created_at,updated_at) VALUES ('ticket','owner','保留标题','保留内容','in_progress',3,'2026-10-01','2026-10-02')")
db.execute("INSERT INTO support_ticket_messages (id,ticket_id,author_id,kind,body,created_at) VALUES ('reply','ticket','owner','reply','保留回复','2026-10-02')")
before = db.execute('SELECT * FROM support_tickets').fetchall()
tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name != 'support_tickets'")]
kept = {table: db.execute(f'SELECT * FROM {table}').fetchall() for table in tables}
db.executescript((root / 'migrations/0025_ticket_images.sql').read_text())
after = db.execute('SELECT * FROM support_tickets').fetchall()
assert [row[:-2] for row in after] == before
assert after[0][-2:] == ('normal', 'other')
for table, rows in kept.items(): assert rows == db.execute(f'SELECT * FROM {table}').fetchall(), table
assert db.execute('SELECT COUNT(*) FROM support_ticket_images').fetchone()[0] == 0
print('PASS: old support tickets/replies, accounts, AI settings and other tables preserved; normal/other defaults')
