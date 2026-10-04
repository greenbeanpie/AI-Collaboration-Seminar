-- Historical editable backgrounds are preserved.
ALTER TABLE materials ADD COLUMN system_managed INTEGER NOT NULL DEFAULT 0 CHECK(system_managed IN (0,1));
CREATE UNIQUE INDEX uq_project_system_background ON materials(project_id) WHERE system_managed=1;
CREATE TRIGGER system_background_goal_insert AFTER INSERT ON project_goals BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.project_id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
CREATE TRIGGER system_background_goal_update AFTER UPDATE OF title,detail ON project_goals BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.project_id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
CREATE TRIGGER system_background_project_update AFTER UPDATE OF name,description ON projects BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
