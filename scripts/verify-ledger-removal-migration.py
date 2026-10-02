"""Verify retirement, backup restoration, and fresh installs using fixture databases only."""
from pathlib import Path
import json
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "backend/migrations").glob("*.sql"))
RETIREMENT = next(path for path in MIGRATIONS if path.name.startswith("0033_"))
REMOVED = {"decisions", "contributions", "resource_references"}


def snapshot(db):
    tables = [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]
    return {table: list(db.execute(f'SELECT * FROM "{table}" ORDER BY rowid')) for table in tables}


with tempfile.TemporaryDirectory(prefix="ledger-retirement-") as directory:
    db = sqlite3.connect(Path(directory) / "populated.sqlite")
    db.execute("PRAGMA foreign_keys=ON")
    for path in MIGRATIONS:
        if path == RETIREMENT:
            break
        db.executescript(path.read_text(encoding="utf-8"))
    now = "2026-10-02T00:00:00.000Z"
    db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES('u','fixture@invalid.test','Fixture',?)", (now,))
    db.execute("INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES('p','Fixture','u',?,?)", (now, now))
    db.execute("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES('m','p','u','owner',?)", (now,))
    db.execute("INSERT INTO tasks(id,project_id,title,created_by,created_at,updated_at) VALUES('t','p','Keep task','u',?,?)", (now, now))
    db.execute("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES('f','p','u','fixture/file','.txt','available',?)", (now,))
    db.execute("INSERT INTO decisions(id,project_id,title,made_by,decided_at,created_at) VALUES('d','p','Old decision','u',?,?)", (now, now))
    for identifier, correction in [("c1", None), ("c2", "c1"), ("c3", "c2")]:
        db.execute("INSERT INTO contributions(id,project_id,user_id,description,correction_of,created_at,updated_at) VALUES(?,'p','u','Fixture contribution',?,?,?)", (identifier, correction, now, now))
    db.execute("INSERT INTO resource_references(id,project_id,kind,title,file_id,declared_by,created_at) VALUES('r','p','file','Fixture file','f','u',?)", (now,))
    db.execute("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,payload_json,occurred_at) VALUES('e','p','user','u','decision.recorded','decision','d','{}',?)", (now,))
    db.commit()
    before = snapshot(db)
    assert not list(db.execute("PRAGMA foreign_key_check"))

    # Restore a real SQLite backup and compare every table and record before deleting.
    backup = sqlite3.connect(Path(directory) / "backup.sqlite")
    db.backup(backup)
    restored = sqlite3.connect(Path(directory) / "restored.sqlite")
    backup.backup(restored)
    assert snapshot(restored) == before, "Backup restore changed fixture records"
    assert not list(restored.execute("PRAGMA foreign_key_check"))

    for path in MIGRATIONS[MIGRATIONS.index(RETIREMENT):]:
        db.executescript("BEGIN;\n" + path.read_text(encoding="utf-8") + "\nCOMMIT;")
    after = snapshot(db)
    assert not REMOVED.intersection(after), "Retired tables remain"
    assert {key: value for key, value in before.items() if key not in REMOVED} == after, "Unrelated records changed"
    assert not list(db.execute("PRAGMA foreign_key_check"))
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"

    fresh = sqlite3.connect(":memory:")
    fresh.execute("PRAGMA foreign_keys=ON")
    for path in MIGRATIONS:
        fresh.executescript(path.read_text(encoding="utf-8"))
    assert not REMOVED.intersection(snapshot(fresh))
    assert not list(fresh.execute("PRAGMA foreign_key_check"))
    assert fresh.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    result = {"result": "PASS", "migration": RETIREMENT.name, "backupRestore": "all tables and rows match", "correctionChainLength": 3, "unrelatedTablesPreserved": len(after), "historicalEventsPreserved": True, "freshInstall": "PASS", "foreignKeys": "PASS", "integrity": "PASS"}
    output = ROOT / "output/ledger-removal-migration.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    for connection in [db, backup, restored, fresh]:
        connection.close()
