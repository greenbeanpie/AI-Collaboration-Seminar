-- Copy legacy member-owned values before clearing their project-scoped copies.
-- No existing global value, publication flag, AI consent or revision is changed.
ALTER TABLE personal_profiles ADD COLUMN weekly_available_hours REAL
  CHECK (weekly_available_hours IS NULL OR (weekly_available_hours >= 0 AND weekly_available_hours <= 168));
CREATE TABLE personal_profile_import_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_project_id TEXT NOT NULL,
  source_project_name TEXT NOT NULL,
  major TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  hours_per_week REAL,
  created_at TEXT NOT NULL,
  imported_at TEXT
);
CREATE INDEX idx_profile_import_owner ON personal_profile_import_candidates(user_id,created_at,id);
INSERT INTO personal_profile_import_candidates(id,user_id,source_project_id,source_project_name,major,skills_json,hours_per_week,created_at)
SELECT m.id,m.user_id,m.project_id,p.name,m.major,m.skills_json,m.hours_per_week,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM project_members m JOIN projects p ON p.id=m.project_id
WHERE trim(m.major)!='' OR m.skills_json!='[]' OR m.hours_per_week IS NOT NULL;
UPDATE project_members SET major='',skills_json='[]',hours_per_week=NULL
WHERE EXISTS (SELECT 1 FROM personal_profile_import_candidates c WHERE c.id=project_members.id AND c.user_id=project_members.user_id);

-- Remove only known structured legacy profile fields, retaining job identity,
-- task/source snapshots, workload, results, attempts and accounting history.
UPDATE jobs SET input_json=json_set(input_json,'$.members',
  (SELECT json_group_array(json(clean)) FROM
    (SELECT json_remove(value,'$.major','$.skills','$.hoursPerWeek') AS clean
     FROM json_each(jobs.input_json,'$.members') ORDER BY CAST(key AS INTEGER))))
WHERE json_valid(input_json) AND json_type(input_json,'$.members')='array'
  AND (kind='assignment_suggest' OR (kind='agent_run' AND json_extract(input_json,'$.operation')='collaboration.assign'));

-- Purpose is metadata; original source and immutable material versions survive.
ALTER TABLE sources ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reference'
  CHECK (purpose IN ('background','reference','output'));
ALTER TABLE sources ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE materials ADD COLUMN purpose TEXT NOT NULL DEFAULT 'output'
  CHECK (purpose IN ('background','reference','output'));
ALTER TABLE materials ADD COLUMN is_default_background INTEGER NOT NULL DEFAULT 0 CHECK(is_default_background IN (0,1));
CREATE UNIQUE INDEX uq_project_default_background ON materials(project_id) WHERE is_default_background=1;

-- A deterministic, bijective first-nibble transform preserves UUID formatting.
-- Keep the concise project description as well as a separately editable note.
INSERT INTO materials(id,project_id,title,kind,purpose,is_default_background,current_version_id,revision,created_by,created_at,updated_at)
SELECT substr('89abcdef01234567',instr('0123456789abcdef',lower(substr(id,1,1))),1)||substr(id,2),
       id,'项目背景','background','background',1,
       substr('456789abcdef0123',instr('0123456789abcdef',lower(substr(id,1,1))),1)||substr(id,2),
       1,created_by,created_at,updated_at
FROM projects WHERE trim(description)!='';
INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
SELECT m.current_version_id,m.id,p.id,1,
       json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text',p.description))))),
       p.description,'manual',p.created_by,p.updated_at
FROM materials m JOIN projects p ON p.id=m.project_id WHERE m.is_default_background=1;
