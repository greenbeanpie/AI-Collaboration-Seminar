CREATE TABLE project_feedback_versions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 feedback TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,version)
);
INSERT INTO project_feedback_versions(id,project_id,version,feedback,actor_id,created_at)
SELECT lower(hex(randomblob(16))),project_id,1,group_concat(feedback,char(10)||char(10)),NULL,MAX(created_at)
FROM (SELECT project_id,feedback,created_at FROM project_admin_feedback WHERE target_type='project' ORDER BY created_at,id)
GROUP BY project_id;
