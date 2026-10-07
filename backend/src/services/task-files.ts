import type { Paging } from '../core/pagination';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, versionConflict } from '../core/errors';
import { projectPermissionSql } from './project-permissions';

/** Re-evaluate membership and executor rights inside every write transaction. */
export function materialManageSql(project: string, actor: string, material = 'materials'): string {
  return `EXISTS(SELECT 1 FROM project_members member WHERE member.project_id=${project} AND member.user_id=${actor}) AND
    (${projectPermissionSql(project, actor, 'resourceManage')} OR
      (${material}.task_id IS NULL AND ${material}.created_by=${actor}) OR
      EXISTS(SELECT 1 FROM tasks task WHERE task.id=${material}.task_id AND task.project_id=${project} AND task.assignee_id=${actor}))`;
}
export function fileManageSql(project: string, actor: string, file = 'files'): string {
  return `EXISTS(SELECT 1 FROM project_members member WHERE member.project_id=${project} AND member.user_id=${actor}) AND
    (${projectPermissionSql(project, actor, 'resourceManage')} OR
      (NOT EXISTS(SELECT 1 FROM task_file_uploads upload WHERE upload.file_id=${file}.id) AND ${file}.uploader_user_id=${actor}) OR
      EXISTS(SELECT 1 FROM task_file_uploads upload JOIN materials material ON material.id=upload.material_id JOIN tasks task ON task.id=material.task_id WHERE upload.file_id=${file}.id AND task.project_id=${project} AND task.assignee_id=${actor}))`;
}
const taskGuard = `EXISTS(SELECT 1 FROM tasks task JOIN project_members member ON member.project_id=task.project_id AND member.user_id=?3 WHERE task.id=?2 AND task.project_id=?1 AND (task.assignee_id=?3 OR ${projectPermissionSql('?1','?3','resourceManage')}))`;
/** Shared list/detail projection preserves archive and per-actor management semantics. */
export async function readTaskFiles(env: Env, projectId: string, taskId: string, actorId: string, materialId?: string, paging?: Paging) {
  const rows = await env.DB.prepare(`SELECT m.created_at createdAt,m.id materialId,m.task_id taskId,m.revision,m.current_version_id versionId,m.archived_at materialArchivedAt,
    f.id fileId,f.original_name name,f.archived_at archivedAt,f.deleted_at deletedAt,f.lifecycle_version lifecycleVersion,
    CASE WHEN ${materialManageSql('?1','?4','m')} THEN 1 ELSE 0 END can_manage
    FROM materials m JOIN material_versions version ON version.id=m.current_version_id
    JOIN files f ON f.id=json_extract(version.attachments_json,'$[0].fileId')
    WHERE m.project_id=?1 AND m.task_id=?2 AND (?3 IS NULL OR m.id=?3) AND m.kind='task-file'
    AND (?5 IS NULL OR m.created_at>?5 OR (m.created_at=?5 AND m.id>?6)) ORDER BY m.created_at,m.id LIMIT ?7`)
    .bind(projectId,taskId,materialId??null,actorId,paging?.cursor?.createdAt??null,paging?.cursor?.id??null,paging ? paging.limit+1 : -1).all<{createdAt:string;materialId:string;taskId:string;revision:number;versionId:string;materialArchivedAt:string|null;fileId:string;name:string;archivedAt:string|null;deletedAt:string|null;lifecycleVersion:number;can_manage:number}>();
  return rows.results.map(({can_manage,...item})=>({...item,canManage:Boolean(can_manage)}));
}
export async function readTaskFile(env: Env, projectId: string, taskId: string, materialId: string, actorId: string) {
  const item=(await readTaskFiles(env,projectId,taskId,actorId,materialId))[0];
  if(!item) throw notFound('任务文件不存在');
  return item;
}
export async function saveTaskFile(env: Env, params: {projectId:string;taskId:string;actorId:string;fileId:string;materialId?:string;expectedRevision?:number;text?:string}) {
  const {projectId,taskId,actorId,fileId}=params;
  if(!await env.DB.prepare('SELECT 1 FROM tasks WHERE id=?1 AND project_id=?2').bind(taskId,projectId).first()) throw notFound('任务不存在');
  if(!await env.DB.prepare(`SELECT 1 WHERE ${taskGuard}`).bind(projectId,taskId,actorId).first()) throw permissionDenied('需要当前任务执行人或资料管理权限');
  const registered=await env.DB.prepare('SELECT m.id,m.task_id FROM task_file_uploads u JOIN materials m ON m.id=u.material_id WHERE u.file_id=?1 AND m.project_id=?2').bind(fileId,projectId).first<{id:string;task_id:string}>();
  if(!params.materialId && registered) {
    if(registered.task_id!==taskId) throw invalidState('文件已登记在其他任务');
    return readTaskFile(env,projectId,taskId,registered.id,actorId);
  }
  if(registered) {
    if(params.materialId===registered.id && registered.task_id===taskId) {
      const current=await readTaskFile(env,projectId,taskId,registered.id,actorId);
      if(current.fileId===fileId) return current;
    }
    throw invalidState('替换版本必须使用新上传的文件');
  }
  const file=await env.DB.prepare(`SELECT original_name,lifecycle_version FROM files WHERE id=?1 AND project_id=?2 AND status='available' AND deleted_at IS NULL AND archived_at IS NULL AND (uploader_user_id=?3 OR ${projectPermissionSql('?2','?3','resourceManage')})`).bind(fileId,projectId,actorId).first<{original_name:string;lifecycle_version:number}>();
  if(!file) throw notFound('文件未上传完成、已归档或不属于当前上传者');
  const materialId=params.materialId??newId(),versionId=newId(),now=nowIso();
  let versionRevision=1;
  let previousLifecycleVersion:number|undefined;
  if(params.materialId) {
    const old=await readTaskFile(env,projectId,taskId,materialId,actorId);
    if(old.materialArchivedAt||old.archivedAt||old.deletedAt) throw invalidState('请先恢复任务文件及材料');
    if(old.revision!==params.expectedRevision) throw versionConflict(old.revision);
    previousLifecycleVersion=old.lifecycleVersion;
    versionRevision=(await env.DB.prepare('SELECT MAX(revision) r FROM material_versions WHERE material_id=?1').bind(materialId).first<{r:number}>())!.r+1;
  }
  const countGuard=`(SELECT COUNT(*) FROM materials m JOIN material_versions v ON v.id=m.current_version_id JOIN files current_file ON current_file.id=json_extract(v.attachments_json,'$[0].fileId') WHERE m.project_id=?1 AND m.task_id=?2 AND m.kind='task-file' AND m.archived_at IS NULL AND current_file.archived_at IS NULL AND current_file.deleted_at IS NULL)<10`;
  const fileGuard=`EXISTS(SELECT 1 FROM files f WHERE f.id=?4 AND f.project_id=?1 AND f.status='available' AND f.deleted_at IS NULL AND f.archived_at IS NULL AND f.lifecycle_version=?5 AND (f.uploader_user_id=?3 OR ${projectPermissionSql('?1','?3','resourceManage')})) AND NOT EXISTS(SELECT 1 FROM task_file_uploads WHERE file_id=?4)`;
  const binds=[projectId,taskId,actorId,fileId,file.lifecycle_version,materialId,versionId,now,file.original_name];
  const writes:D1PreparedStatement[]=[];
  if(!params.materialId) writes.push(env.DB.prepare(`INSERT INTO materials(id,project_id,task_id,title,kind,purpose,current_version_id,revision,created_by,created_at,updated_at)
    SELECT ?6,?1,?2,?9,'task-file','output',?7,1,?3,?8,?8 WHERE ${taskGuard} AND ${fileGuard} AND ${countGuard}`).bind(...binds));
  const materialGuard=params.materialId ? `EXISTS(SELECT 1 FROM materials WHERE id=?6 AND project_id=?1 AND task_id=?2 AND revision=?13 AND archived_at IS NULL AND ${materialManageSql('?1','?3')} AND EXISTS(SELECT 1 FROM material_versions current_version JOIN files original ON original.id=json_extract(current_version.attachments_json,'$[0].fileId') WHERE current_version.id=materials.current_version_id AND original.deleted_at IS NULL AND original.archived_at IS NULL AND original.lifecycle_version=?14))` : 'EXISTS(SELECT 1 FROM materials WHERE id=?6 AND current_version_id=?7)';
  writes.push(env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,attachments_json,origin,author_id,created_at)
    SELECT ?7,?6,?1,?10,'{"type":"doc","content":[]}',?12,?11,'manual',?3,?8 WHERE ${taskGuard} AND ${fileGuard} AND ${materialGuard}`)
    .bind(...binds,versionRevision,JSON.stringify([{fileId,name:file.original_name}]),params.text?.trim()??'',...(params.materialId?[params.expectedRevision,previousLifecycleVersion]:[])));
  writes.push(env.DB.prepare(`UPDATE materials SET current_version_id=?2,title=?3,revision=revision+1,updated_at=?4 WHERE id=?1 AND EXISTS(SELECT 1 FROM material_versions WHERE id=?2) AND current_version_id!=?2`).bind(materialId,versionId,file.original_name,now));
  writes.push(env.DB.prepare(`INSERT INTO task_file_uploads(file_id,material_id) SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM material_versions WHERE id=?3 AND material_id=?2)`).bind(fileId,materialId,versionId));
  const mappingIndex = writes.length - 1;
  writes.push(env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at)
    SELECT ?1,?2,'user',?3,'task.file_saved','material',?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM task_file_uploads WHERE file_id=?8 AND material_id=?4) AND EXISTS(SELECT 1 FROM materials WHERE id=?4 AND current_version_id=?5)
    ON CONFLICT(project_id,type,entity_type,entity_id,dedup_key) DO NOTHING`).bind(newId(),projectId,actorId,materialId,versionId,JSON.stringify({taskId,fileId,versionId}),now,fileId));
  const results=await env.DB.batch(writes);
  if(!results[mappingIndex]?.meta.changes) {
    if(!params.materialId) {
      const concurrent=await env.DB.prepare('SELECT m.id FROM task_file_uploads u JOIN materials m ON m.id=u.material_id WHERE u.file_id=?1 AND m.project_id=?2 AND m.task_id=?3').bind(fileId,projectId,taskId).first<{id:string}>();
      if(concurrent) return readTaskFile(env,projectId,taskId,concurrent.id,actorId);
    }
    throw invalidState('任务分工、权限、文件状态或数量限制已变化，请刷新');
  }
  return readTaskFile(env,projectId,taskId,materialId,actorId);
}
export async function archiveFile(env: Env, params:{projectId:string;fileId:string;actorId:string;expectedLifecycleVersion:number;restore:boolean}) {
  const {projectId,fileId,actorId,expectedLifecycleVersion,restore}=params;
  const file=await env.DB.prepare(`SELECT status,archived_at,deleted_at,lifecycle_version,CASE WHEN ${fileManageSql('?2','?3')} THEN 1 ELSE 0 END allowed FROM files WHERE id=?1 AND project_id=?2`).bind(fileId,projectId,actorId).first<{status:string;archived_at:string|null;deleted_at:string|null;lifecycle_version:number;allowed:number}>();
  if(!file) throw notFound('文件不存在');
  if(!file.allowed) throw permissionDenied('没有管理此文件的权限');
  if(file.status!=='available') throw invalidState('请等待文件上传完成后归档');
  if(file.deleted_at||Boolean(file.archived_at)!==restore||file.lifecycle_version!==expectedLifecycleVersion) throw invalidState('文件生命周期已变化');
  const now = nowIso();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE files SET archived_at=?4,lifecycle_version=lifecycle_version+1 WHERE id=?1 AND project_id=?2 AND lifecycle_version=?5 AND status='available' AND deleted_at IS NULL AND archived_at IS ${restore?'NOT NULL':'NULL'} AND ${fileManageSql('?2','?3')}`).bind(fileId,projectId,actorId,restore?null:now,expectedLifecycleVersion),
    env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at)
      SELECT ?1,?2,'user',?3,?4,'file',?5,?6,?7,?8 WHERE changes()=1 AND EXISTS(SELECT 1 FROM files WHERE id=?5 AND lifecycle_version=?9 AND archived_at IS ${restore?'NULL':'NOT NULL'} AND ${fileManageSql('?2','?3')})
      ON CONFLICT(project_id,type,entity_type,entity_id,dedup_key) DO NOTHING`).bind(newId(),projectId,actorId,restore?'file.unarchived':'file.archived',fileId,String(expectedLifecycleVersion+1),JSON.stringify({restore}),now,expectedLifecycleVersion+1),
  ]);
  if(!results[0]?.meta.changes) throw invalidState('文件状态或权限已变化');
  return {fileId,archivedAt:restore?null:(await env.DB.prepare('SELECT archived_at FROM files WHERE id=?1').bind(fileId).first<{archived_at:string}>())!.archived_at,lifecycleVersion:expectedLifecycleVersion+1};
}
export async function archiveMaterial(env:Env, params:{projectId:string;materialId:string;actorId:string;expectedRevision:number;restore:boolean}) {
  const {projectId,materialId,actorId,expectedRevision,restore}=params;
  const row=await env.DB.prepare(`SELECT revision,archived_at,system_managed,CASE WHEN ${materialManageSql('?2','?3')} THEN 1 ELSE 0 END allowed FROM materials WHERE id=?1 AND project_id=?2`).bind(materialId,projectId,actorId).first<{revision:number;archived_at:string|null;system_managed:number;allowed:number}>();
  if(!row) throw notFound('材料不存在');
  if(!row.allowed||row.system_managed) throw permissionDenied('没有管理此材料的权限');
  if(row.revision!==expectedRevision) throw versionConflict(row.revision);
  if(Boolean(row.archived_at)!==restore) throw invalidState('材料归档状态已变化');
  const now=nowIso();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE materials SET archived_at=?4,revision=revision+1,updated_at=?5 WHERE id=?1 AND project_id=?2 AND revision=?6 AND system_managed=0 AND archived_at IS ${restore?'NOT NULL':'NULL'} AND ${materialManageSql('?2','?3')}`).bind(materialId,projectId,actorId,restore?null:now,now,expectedRevision),
    env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at)
      SELECT ?1,?2,'user',?3,?4,'material',?5,?6,?7,?8 WHERE changes()=1 AND EXISTS(SELECT 1 FROM materials WHERE id=?5 AND revision=?9 AND archived_at IS ${restore?'NULL':'NOT NULL'} AND ${materialManageSql('?2','?3')})
      ON CONFLICT(project_id,type,entity_type,entity_id,dedup_key) DO NOTHING`).bind(newId(),projectId,actorId,restore?'material.unarchived':'material.archived',materialId,String(expectedRevision+1),JSON.stringify({restore}),now,expectedRevision+1),
  ]);
  if(!results[0]?.meta.changes) throw invalidState('材料状态或权限已变化');
  return {materialId,archivedAt:restore?null:now,revision:expectedRevision+1};
}
