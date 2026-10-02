import type { Env } from '../env';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { nowIso } from '../core/db';
import { settleReservation } from './budget';
import { projectAccess, projectPermissionSql } from './project-permissions';

export const lifecycleBodyDescription = '当前生命周期版本，删除和恢复都递增；旧请求不得重放';

/** Project membership remains mandatory. Account admin never bypasses project access. */
function actorGuard(table: 'files'|'sources'): string {
  const creator = table === 'files' ? 'uploader_user_id' : 'created_by';
  return `EXISTS (SELECT 1 FROM project_members actor WHERE actor.project_id=${table}.project_id AND actor.user_id=?4
    AND (${projectPermissionSql(`${table}.project_id`,'?4','resourceManage')} OR ${table}.${creator}=?4))`;
}

export async function canManageResource(env: Env, projectId: string, actorId: string, creatorId: string): Promise<boolean> {
  try { return (await projectAccess(env,projectId,actorId)).permissions.resourceManage || creatorId === actorId; } catch { return false; }
}

// This predicate includes current and prior source versions, plus generated OCR page images.
const referencedSources = `SELECT v.source_id FROM source_versions v WHERE v.project_id=?2 AND (v.file_id=?1
  OR EXISTS (SELECT 1 FROM source_pages page WHERE page.source_version_id=v.id AND page.image_file_id=?1))`;

function cancelSourceJobs(env: Env, sourceIdsSql: string, binds: unknown[], now: string): D1PreparedStatement[] {
  const versionIds = `SELECT v.id FROM source_versions v WHERE v.source_id IN (${sourceIdsSql})`;
  const at = `?${binds.length + 1}`;
  return [
    env.DB.prepare(`UPDATE jobs SET status='cancelled',error_json=json_object('code','INVALID_STATE','message','来源已移入回收站'),finished_at=${at},updated_at=${at}
      WHERE status IN ('queued','running','waiting_input') AND (json_extract(input_json,'$.sourceVersionId') IN (${versionIds})
        OR EXISTS(SELECT 1 FROM json_each(input_json,'$.sourceSnapshots') captured WHERE json_extract(captured.value,'$.sourceId') IN (${sourceIdsSql}))
        OR EXISTS(SELECT 1 FROM json_each(input_json,'$.toolFileSnapshots') captured WHERE json_extract(captured.value,'$.sourceId') IN (${sourceIdsSql})))`)
      .bind(...binds,now),
    env.DB.prepare(`UPDATE job_outbox SET status='failed',last_error='SOURCE_RECYCLED',lease_until=NULL,updated_at=?
      WHERE job_id IN (SELECT id FROM jobs WHERE status='cancelled' AND updated_at=? AND error_json LIKE '%来源已移入回收站%')`).bind(now,now),
    env.DB.prepare(`UPDATE source_processing SET
      text_status=CASE WHEN text_status IN ('processing','waiting_input') THEN 'failed' ELSE text_status END,
      requirements_status=CASE WHEN requirements_status='processing' THEN 'failed' ELSE requirements_status END,
      requirements_error=CASE WHEN requirements_status='processing' THEN '来源已移入回收站；恢复后可手动重新处理' ELSE requirements_error END,
      summary_status=CASE WHEN summary_status IN ('pending','queued','running') THEN 'cancelled' ELSE summary_status END,
      summary_error=CASE WHEN summary_status IN ('pending','queued','running') THEN '来源已移入回收站；恢复不会自动调用 AI' ELSE summary_error END,
      summary_revision=summary_revision+1,updated_at=${at} WHERE source_version_id IN (${versionIds})`).bind(...binds,now),
  ];
}

async function releaseCancelledReservations(env: Env, now: string): Promise<void> {
  const jobs=await env.DB.prepare("SELECT id FROM jobs WHERE status='cancelled' AND updated_at=?1 AND error_json LIKE '%来源已移入回收站%'").bind(now).all<{id:string}>();
  // An already started provider call is kept pending_reconcile by settleReservation;
  // cancellation never pretends that incurred/unknown costs were free.
  for (const job of jobs.results) await settleReservation(env,job.id,'released');
}

export async function changeFileLifecycle(env: Env, params: {projectId:string;fileId:string;actorId:string;expectedLifecycleVersion:number;restore:boolean}): Promise<{fileId:string;deletedAt:string|null;lifecycleVersion:number;affectedSourceIds:string[]}> {
  const row=await env.DB.prepare('SELECT uploader_user_id,deleted_at,lifecycle_version FROM files WHERE id=?1 AND project_id=?2').bind(params.fileId,params.projectId).first<{uploader_user_id:string;deleted_at:string|null;lifecycle_version:number}>();
  if(!row) throw notFound('文件不存在');
  if(!await canManageResource(env,params.projectId,params.actorId,row.uploader_user_id)) throw permissionDenied('只有项目负责人或上传者可删除和恢复文件');
  if(row.lifecycle_version!==params.expectedLifecycleVersion || Boolean(row.deleted_at)!==params.restore) throw invalidState('文件生命周期已变化，请刷新后重试');
  const now=nowIso(); const next=params.expectedLifecycleVersion+1;const transitionId=crypto.randomUUID();
  const fileGuard=`EXISTS(SELECT 1 FROM files f WHERE f.id=?1 AND f.project_id=?2 AND f.lifecycle_version=?3 AND f.deleted_by IS ?4 AND f.deleted_at IS ?5 AND f.lifecycle_change_id=?6)`;
  const fileBinds=[params.fileId,params.projectId,next,params.restore?null:params.actorId,params.restore?null:now,transitionId];
  const sourceScope=params.restore?`SELECT id FROM sources WHERE deleted_via_file_id IS NOT NULL AND project_id=?2 AND deleted_at IS NOT NULL AND (deleted_via_file_id=?1 OR id IN (${referencedSources}))`:`${referencedSources}`;
  const sources=await env.DB.prepare(sourceScope).bind(params.fileId,params.projectId).all<{id?:string;source_id?:string}>();
  const batch=[env.DB.prepare(`UPDATE files SET deleted_at=?5,deleted_by=?6,lifecycle_version=lifecycle_version+1,lifecycle_change_id=?7,gc_after=NULL
    WHERE id=?1 AND project_id=?2 AND lifecycle_version=?3 AND ${params.restore?'deleted_at IS NOT NULL':'deleted_at IS NULL'} AND ${actorGuard('files')}`)
    .bind(params.fileId,params.projectId,params.expectedLifecycleVersion,params.actorId,params.restore?null:now,params.restore?null:params.actorId,transitionId)];
  if(params.restore) {
    batch.push(env.DB.prepare(`UPDATE sources SET deleted_at=NULL,deleted_by=NULL,deleted_via_file_id=NULL,lifecycle_version=lifecycle_version+1,lifecycle_change_id=?6,updated_at=?7
      WHERE project_id=?2 AND deleted_via_file_id IS NOT NULL AND (deleted_via_file_id=?1 OR id IN (${referencedSources})) AND deleted_at IS NOT NULL AND ${fileGuard}
      AND NOT EXISTS(SELECT 1 FROM source_versions v JOIN files original ON original.id=v.file_id WHERE v.source_id=sources.id AND original.deleted_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM source_versions v JOIN source_pages page ON page.source_version_id=v.id JOIN files image ON image.id=page.image_file_id WHERE v.source_id=sources.id AND image.deleted_at IS NOT NULL)`)
      .bind(...fileBinds,now));
  } else {
    batch.push(env.DB.prepare(`UPDATE sources SET deleted_at=?5,deleted_by=?4,deleted_via_file_id=?1,lifecycle_version=lifecycle_version+1,lifecycle_change_id=?6,updated_at=?5
      WHERE id IN (${referencedSources}) AND project_id=?2 AND deleted_at IS NULL AND ${fileGuard}`).bind(...fileBinds));
    const touched=`SELECT id FROM sources WHERE project_id=?2 AND deleted_via_file_id=?1 AND deleted_at=?5 AND ${fileGuard}`;
    batch.push(env.DB.prepare(`UPDATE jobs SET status='cancelled',error_json=json_object('code','INVALID_STATE','message','来源已移入回收站'),finished_at=?5,updated_at=?5
      WHERE project_id=?2 AND status IN ('queued','running','waiting_input') AND ${fileGuard}
      AND EXISTS(SELECT 1 FROM json_each(input_json,'$.toolFileSnapshots') captured WHERE json_extract(captured.value,'$.fileId')=?1)`).bind(...fileBinds));
    batch.push(...cancelSourceJobs(env,touched,fileBinds,now));
  }
  const result=await env.DB.batch(batch);
  if(!result[0]?.meta.changes) throw invalidState('文件状态或操作权限已变化，请刷新后重试');
  if(!params.restore) await releaseCancelledReservations(env,now);
  return {fileId:params.fileId,deletedAt:params.restore?null:now,lifecycleVersion:next,affectedSourceIds:[...new Set(sources.results.map(s=>s.id??s.source_id!).filter(Boolean))]};
}

export async function changeSourceLifecycle(env:Env,params:{projectId:string;sourceId:string;actorId:string;expectedLifecycleVersion:number;restore:boolean}):Promise<{sourceId:string;deletedAt:string|null;lifecycleVersion:number}> {
  const row=await env.DB.prepare('SELECT created_by,kind,deleted_at,deleted_via_file_id,lifecycle_version FROM sources WHERE id=?1 AND project_id=?2').bind(params.sourceId,params.projectId).first<{created_by:string;kind:string;deleted_at:string|null;deleted_via_file_id:string|null;lifecycle_version:number}>();
  if(!row) throw notFound('来源不存在');
  if(!await canManageResource(env,params.projectId,params.actorId,row.created_by)) throw permissionDenied('只有项目负责人或来源创建者可删除和恢复来源');
  if(row.kind==='file'||row.deleted_via_file_id) throw invalidState('文件来源请通过文件库删除或恢复原文件');
  if(row.lifecycle_version!==params.expectedLifecycleVersion||Boolean(row.deleted_at)!==params.restore) throw invalidState('来源生命周期已变化，请刷新后重试');
  const now=nowIso();const next=params.expectedLifecycleVersion+1;const transitionId=crypto.randomUUID();
  const batch=[env.DB.prepare(`UPDATE sources SET deleted_at=?5,deleted_by=?6,lifecycle_version=lifecycle_version+1,lifecycle_change_id=?8,updated_at=?7
    WHERE id=?1 AND project_id=?2 AND lifecycle_version=?3 AND ${params.restore?'deleted_at IS NOT NULL':'deleted_at IS NULL'} AND ${actorGuard('sources')}`)
    .bind(params.sourceId,params.projectId,params.expectedLifecycleVersion,params.actorId,params.restore?null:now,params.restore?null:params.actorId,now,transitionId)];
  if(!params.restore) {
    const touched=`SELECT id FROM sources WHERE id=?1 AND project_id=?2 AND lifecycle_version=?3 AND deleted_at=?4 AND lifecycle_change_id=?5`;
    batch.push(...cancelSourceJobs(env,touched,[params.sourceId,params.projectId,next,now,transitionId],now));
  }
  const result=await env.DB.batch(batch);
  if(!result[0]?.meta.changes) throw invalidState('来源状态或操作权限已变化，请刷新后重试');
  if(!params.restore) await releaseCancelledReservations(env,now);
  return {sourceId:params.sourceId,deletedAt:params.restore?null:now,lifecycleVersion:next};
}
