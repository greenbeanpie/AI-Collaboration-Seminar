import type { Env } from '../env';
import { invalidState } from '../core/errors';
import { buildStandardsSnapshot, type StandardRow, type StandardSnapshot } from './project-simplification';

/** Only the latest saved version is active, including pre-existing saved drafts. */
export function effectiveStandardGuardSql(projectSql:string,idSql:string):string {
  return `EXISTS(SELECT 1 FROM standards_versions active_standard WHERE active_standard.project_id=${projectSql} AND active_standard.id=${idSql} AND active_standard.version=(SELECT MAX(version) FROM standards_versions WHERE project_id=${projectSql}))`;
}
export async function effectiveStandard(env:Env,projectId:string):Promise<StandardSnapshot|null> {
  const row=await env.DB.prepare('SELECT * FROM standards_versions WHERE project_id=?1 ORDER BY version DESC LIMIT 1').bind(projectId).first<StandardRow>();
  return row ? row.snapshot_json ? JSON.parse(row.snapshot_json) as StandardSnapshot : buildStandardsSnapshot(env,row) : null;
}
export async function assertEffectiveStandard(env:Env,projectId:string,id?:string):Promise<StandardSnapshot> {
  const standard=await effectiveStandard(env,projectId);
  if(!standard)throw invalidState('请先保存项目标准');
  if(id!==undefined&&standard.standardsVersionId!==id)throw invalidState('项目标准已更新，请使用当前生效标准');
  return standard;
}

/** Freeze absence as well as a version so a newly saved standard invalidates an old operation. */
export function effectiveStandardCaptureGuardSql(projectSql:string,idSql:string):string {
  return `((${idSql} IS NULL AND NOT EXISTS(SELECT 1 FROM standards_versions WHERE project_id=${projectSql})) OR ${effectiveStandardGuardSql(projectSql,idSql)})`;
}
export async function assertEffectiveStandardCapture(env:Env,projectId:string,id:string|null):Promise<void>{
  const current=(await env.DB.prepare('SELECT id FROM standards_versions WHERE project_id=?1 ORDER BY version DESC LIMIT 1').bind(projectId).first<{id:string}>())?.id??null;
  if(current!==id)throw invalidState('项目标准已更新，请重新发起');
}
