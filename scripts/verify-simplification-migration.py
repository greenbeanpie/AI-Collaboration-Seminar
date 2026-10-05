"""Exercise project simplification on a populated in-memory database only."""
from pathlib import Path
import json
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "backend" / "migrations"
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted(MIGRATIONS.glob("*.sql")):
    if migration.name.startswith("0025_"):
        break
    db.executescript(migration.read_text(encoding="utf-8"))

now = "2026-10-02T00:00:00.000Z"
owner = "11111111-1111-4111-8111-111111111111"
p1 = "22222222-2222-4222-8222-222222222222"
p2 = "33333333-3333-4333-8333-333333333333"
db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES(?,?,?,?)", (owner,"fixture@invalid.test","Fixture",now))
db.execute("INSERT INTO personal_profiles(user_id,bio,major,specialties,preferred_roles,revision,updated_at,ai_use_allowed) VALUES(?,?,?,?,?,?,?,?)", (owner,"Existing bio","Existing major","Existing skills","Existing role",7,now,1))
for i, project in enumerate((p1,p2),1):
    db.execute("INSERT INTO projects(id,name,description,created_by,created_at,updated_at,assignment_mode,evaluation_mode) VALUES(?,?,?,?,?,?,?,?)", (project,f"Project {i}",f"Background {i}",owner,now,now,"manual","automatic"))
    db.execute("INSERT INTO project_members(id,project_id,user_id,role,major,skills_json,hours_per_week,joined_at) VALUES(?,?,?,?,?,?,?,?)", (f"membership-{i}",project,owner,"owner",f"Legacy major {i}",json.dumps([f"Legacy skill {i}"]),float(i),now))

db.execute("INSERT INTO tasks(id,project_id,title,status,revision,created_by,created_at,updated_at) VALUES('old-done',?,'Old completed','done',9,?,?,?)",(p1,owner,now,now))
db.execute("INSERT INTO tasks(id,project_id,title,status,lifecycle_state,criteria,revision,created_by,created_at,updated_at,current_submission_id) VALUES('accepted-task',?,'Accepted','done','accepted','Frozen criteria',4,?,?,?,'submission')",(p1,owner,now,now))
db.execute("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,criteria,task_revision,status,ai_report_json,created_at,updated_at) VALUES('submission',?,'accepted-task',1,?,'Frozen artifact','Frozen criteria',4,'accept','{\"feedback\":\"Preserve\"}',?,?)",(p1,owner,now,now))
db.execute("INSERT INTO materials(id,project_id,title,current_version_id,revision,created_by,created_at,updated_at) VALUES('original-material',?,'Original','original-version',3,?,?,?)",(p1,owner,now,now))
db.execute("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES('original-version','original-material',?,3,'{}','Immutable original body','manual',?,?)",(p1,owner,now))
db.execute("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES('original-file',?,?,'fixture/original.txt','.txt','available',?)",(p1,owner,now))
db.execute("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at,current_version_id) VALUES('original-source',?,'file','Original source',?,?,?,'source-version')",(p1,owner,now,now))
db.execute("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,text_r2_key,status,created_at) VALUES('source-version','original-source',?,1,'file','original-file','fixture/text','ready',?)",(p1,now))
job_input = {"members":[{"userId":owner,"major":"Legacy major","skills":["Legacy skill"],"hoursPerWeek":2,"loadHours":1}],"tasks":[],"operation":"collaboration.assign"}
db.execute("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES('assignment-job',?,'agent_run','succeeded',?,1,?,?,?)",(p1,json.dumps(job_input),owner,now,now))
db.execute("INSERT INTO job_outbox(id,job_id,status,available_at,attempts,created_at,updated_at) VALUES('outbox','assignment-job','done',?,1,?,?)",(now,now,now))
db.execute("INSERT INTO usage_reservations(id,project_id,job_id,purpose,status,created_at,attempts_started) VALUES('reservation',?,'assignment-job','agent_run','reserved',?,1)",(p1,now))
db.execute("INSERT INTO task_links(id,task_id,project_id,kind,target_id,created_at) VALUES('link','accepted-task',?,'material','original-material',?)",(p1,now))
db.commit()

tables=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
snapshot={}
for table in tables:
    columns=[row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
    selection=",".join(f'"{column}"' for column in columns)
    snapshot[table]=(columns,list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid')))
assert not list(db.execute("PRAGMA foreign_key_check"))

for migration in sorted(MIGRATIONS.glob("*.sql")):
    if migration.name >= "0025_":
        db.executescript("BEGIN;\n"+migration.read_text(encoding="utf-8")+"\nCOMMIT;")

for table,(columns,rows) in snapshot.items():
    if table in {"contributions", "resource_references", "decisions"}:
        continue  # Deliberately removed by the ledger retirement migration.
    # 0043 removes only the obsolete parent relationship; the task itself survives.
    ignored={"project_members":{"major","skills_json","hours_per_week"},"jobs":{"input_json"},"tasks":{"parent_task_id"}}.get(table,set())
    indices=[i for i,column in enumerate(columns) if column not in ignored]
    selection=",".join(f'"{columns[i]}"' for i in indices)
    after=list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid'))
    expected=[tuple(row[i] for i in indices) for row in rows]
    observed=after
    if table == "app_config":
        # Migration 0030 removes the obsolete team-size cap from the default template.
        value_index = columns.index("value_json")
        updated_index = columns.index("updated_at")
        key_index = columns.index("key")
        def normalize_config(row):
            if row[key_index] != "competition_template":
                return row
            values = list(row)
            config = json.loads(values[value_index])
            config.pop("teamSizeLimit", None)
            values[value_index] = json.dumps(config, sort_keys=True)
            values[updated_index] = "<migration timestamp>"
            return tuple(values)
        expected = [normalize_config(row) for row in expected]
        observed = [normalize_config(row) for row in observed]
    for row in expected:
        assert row in observed, f"Existing data changed or disappeared in {table}: {row[0]}"

assert db.execute("SELECT COUNT(*) FROM project_goals").fetchone()[0] == 2
assert db.execute("SELECT lifecycle_state,status,revision FROM tasks WHERE id='old-done'").fetchone() == (None,"done",9)
assert db.execute("SELECT COUNT(*) FROM personal_profile_import_candidates WHERE user_id=?",(owner,)).fetchone()[0] == 2
for i in (1,2):
    candidate=db.execute("SELECT user_id,source_project_id,major,skills_json,hours_per_week FROM personal_profile_import_candidates WHERE id=?",(f"membership-{i}",)).fetchone()
    assert candidate == (owner,(p1,p2)[i-1],f"Legacy major {i}",json.dumps([f"Legacy skill {i}"]),float(i)), "Migration changed a preserved personal value"
assert db.execute("SELECT major,skills_json,hours_per_week FROM project_members WHERE id='membership-1'").fetchone() == ("","[]",None)
assert db.execute("SELECT major,specialties,revision,ai_use_allowed FROM personal_profiles WHERE user_id=?",(owner,)).fetchone() == ("Existing major","Existing skills",7,1)
assert db.execute("SELECT weekly_available_hours FROM personal_profiles WHERE user_id=?",(owner,)).fetchone()[0] is None
members=json.loads(db.execute("SELECT input_json FROM jobs WHERE id='assignment-job'").fetchone()[0])["members"]
assert members[0]["userId"] == owner and members[0]["loadHours"] == 1
assert not {"major","skills","hoursPerWeek"}.intersection(members[0])
assert not list(db.execute("PRAGMA foreign_key_check"))
print(f"PASS: {len(tables)} existing tables preserve original IDs/history; 2 goals; conflicting personal candidates retained privately; legacy fields cleared; global consent unchanged; foreign keys intact")
