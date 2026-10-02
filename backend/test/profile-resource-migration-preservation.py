"""Exercise the upgrade and rollback against populated in-memory SQLite only."""
from pathlib import Path
import json
import sqlite3
import uuid

root = Path(__file__).resolve().parents[1]
upgrade = (root / "migrations/0026_profile_resource_simplification.sql").read_text(encoding="utf-8")
now = "2026-10-02T00:00:00.000Z"


def fixture(collision=False):
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    for path in sorted((root / "migrations").glob("*.sql")):
        if path.name >= "0026_profile_resource_simplification.sql":
            break
        db.executescript(path.read_text(encoding="utf-8"))
    user = str(uuid.uuid4())
    db.execute("INSERT INTO users(id,email,display_name,created_at) VALUES(?,?,?,?)", (user,"fixture@invalid.test","Owner",now))
    projects = [str(uuid.uuid4()) for _ in range(2)]
    members = [str(uuid.uuid4()) for _ in range(2)]
    for i, (project, member) in enumerate(zip(projects,members)):
        db.execute("INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)", (project,f"Project {i}",f"Background {i}\nPreserve original",user,now,now))
        db.execute("INSERT INTO project_members(id,project_id,user_id,role,major,skills_json,hours_per_week,joined_at) VALUES(?,?,?,'owner',?,?,?,?)", (member,project,user,f"Major {i}",json.dumps([f"Skill {i}"],ensure_ascii=False),i * 5,now))
    db.execute("INSERT INTO personal_profiles(user_id,searchable,bio,major,specialties,preferred_roles,bio_public,major_public,specialties_public,preferred_roles_public,revision,updated_at,ai_use_allowed) VALUES(?,1,'Existing bio','Existing major','Existing skill','Existing role',1,1,1,1,7,?,1)", (user,now))
    task = str(uuid.uuid4())
    db.execute("INSERT INTO tasks(id,project_id,title,status,revision,created_by,created_at,updated_at) VALUES(?,?,'Retain task','todo',4,?,?,?)",(task,projects[0],user,now,now))
    source, source_version, material, material_version = [str(uuid.uuid4()) for _ in range(4)]
    db.execute("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?,?,'paste','Retain source',?,?,?,?)", (source,projects[0],source_version,user,now,now))
    db.execute("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?,?,?,1,'paste','ready',?)", (source_version,source,projects[0],now))
    if collision:
        material = f"{(int(projects[0][0],16) + 8) % 16:x}" + projects[0][1:]
    db.execute("INSERT INTO materials(id,project_id,title,current_version_id,created_by,created_at,updated_at) VALUES(?,?,'Retain material',?,?,?,?)", (material,projects[0],material_version,user,now,now))
    db.execute("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?,?,?,1,?,?,'manual',?,?)", (material_version,material,projects[0],'{"type":"doc","content":[]}',"Retain original markdown",user,now))
    job = str(uuid.uuid4())
    input_doc = {"operation":"collaboration.assign","members":[{"userId":user,"major":"structured secret","skills":["structured skill"],"hoursPerWeek":0,"loadHours":3}],"tasks":[{"taskId":task,"detail":"User-written major is ordinary project content"}],"sourceVersionIds":[source_version]}
    db.execute("INSERT INTO jobs(id,project_id,kind,status,input_json,result_json,attempts,created_by,created_at,updated_at) VALUES(?,?,'agent_run','succeeded',?,?,2,?,?,?)",(job,projects[0],json.dumps(input_doc),'{"assignments":[]}',user,now,now))
    db.commit()
    return db, user, projects, members, task, source, source_version, material, material_version, job


db, user, projects, members, task, source, source_version, material, material_version, job = fixture()
tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
snapshots = {}
for table in tables:
    columns = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
    selection = ",".join(f'"{column}"' for column in columns)
    snapshots[table] = (selection, list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid')))
db.executescript("BEGIN;\n" + upgrade + "\nCOMMIT;")
for table, (selection, before) in snapshots.items():
    if table in {"project_members", "jobs", "materials", "material_versions"}:
        continue
    assert list(db.execute(f'SELECT {selection} FROM "{table}" ORDER BY rowid')) == before, table
assert db.execute("SELECT COUNT(*) FROM personal_profile_import_candidates").fetchone()[0] == 2
for i, member in enumerate(members):
    assert db.execute("SELECT user_id,source_project_id,major,skills_json,hours_per_week FROM personal_profile_import_candidates WHERE id=?",(member,)).fetchone() == (user,projects[i],f"Major {i}",json.dumps([f"Skill {i}"],ensure_ascii=False),i*5)
    assert db.execute("SELECT user_id,project_id,major,skills_json,hours_per_week FROM project_members WHERE id=?",(member,)).fetchone() == (user,projects[i],"","[]",None)
assert db.execute("SELECT major,revision,ai_use_allowed,searchable,weekly_available_hours FROM personal_profiles WHERE user_id=?",(user,)).fetchone() == ("Existing major",7,1,1,None)
clean = json.loads(db.execute("SELECT input_json FROM jobs WHERE id=?",(job,)).fetchone()[0])
assert clean["members"] == [{"userId":user,"loadHours":3}]
assert clean["tasks"][0]["detail"] == "User-written major is ordinary project content"
assert clean["sourceVersionIds"] == [source_version]
assert db.execute("SELECT status,result_json,attempts FROM jobs WHERE id=?",(job,)).fetchone() == ("succeeded",'{"assignments":[]}',2)
assert db.execute("SELECT title,current_version_id FROM materials WHERE id=?",(material,)).fetchone() == ("Retain material",material_version)
assert db.execute("SELECT markdown FROM material_versions WHERE id=?",(material_version,)).fetchone()[0] == "Retain original markdown"
assert db.execute("SELECT COUNT(*) FROM materials WHERE is_default_background=1").fetchone()[0] == 2
for project in projects:
    note = db.execute("SELECT m.id,v.id,v.markdown,v.doc_json FROM materials m JOIN material_versions v ON v.id=m.current_version_id WHERE m.project_id=? AND m.is_default_background=1",(project,)).fetchone()
    uuid.UUID(note[0]); uuid.UUID(note[1])
    description = db.execute("SELECT description FROM projects WHERE id=?",(project,)).fetchone()[0]
    assert note[2] == description
    assert json.loads(note[3])["content"][0]["content"][0]["text"] == description
assert not list(db.execute("PRAGMA foreign_key_check"))

# Force a late collision after the copy/clear statements: the migration batch
# must roll back the entire upgrade rather than lose the original member data.
bad, _, _, old_members, *_ = fixture(collision=True)
try:
    bad.executescript("BEGIN;\n" + upgrade + "\nCOMMIT;")
    raise AssertionError("Expected deterministic background ID collision")
except sqlite3.IntegrityError:
    bad.rollback()
assert bad.execute("SELECT major,skills_json,hours_per_week FROM project_members WHERE id=?",(old_members[0],)).fetchone() == ("Major 0",'["Skill 0"]',0)
assert not bad.execute("SELECT name FROM sqlite_master WHERE name='personal_profile_import_candidates'").fetchall()
assert not list(bad.execute("PRAGMA foreign_key_check"))
print("PASS: multi-project legacy candidates, zero hours, owner/privacy/consent preservation, structured job cleanup, immutable IDs/history, background notes and atomic rollback")
