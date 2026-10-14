import type { Env } from '../env';
import { AppError, invalidState } from '../core/errors';
import { newId, nowIso } from '../core/db';
import { loadResourcePolicy } from './resource-policy';
import { ConcurrencyWait } from './ai-execution-slices';

export interface AiResourceContext { userId?: string | null; projectId?: string | null; jobId?: string; draftAttemptId?: string; operation?: string; requestId?:string; model?:string }
export interface AiResourceClaim { id: string }
/** Shared, non-secret actor for authenticated operational-token diagnostics, never accepted from request bodies. */
export const OPERATOR_TOKEN_AI_ACTOR='system:operator-token';
type QuotaEnv=Pick<Env,'DB'> & Partial<Pick<Env,'ENV_NAME'>>;
/** UTC+8 calendar day, independent of the Worker/CI host timezone. */
export const aiQuotaDay = (date = new Date()) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export class ResourceConcurrencyWait extends ConcurrencyWait { constructor() { super(); this.message = '等待平台 AI 并发名额，尚未发起模型请求'; } }
export const isAiResourceGuard=(error:unknown)=>error instanceof AppError&&error.details?.resourceQuota===true;
export const isAiAdmissionRejection=(error:unknown)=>isAiResourceGuard(error)||error instanceof ConcurrencyWait||error instanceof AppError&&error.code==='PERMISSION_DENIED';

export async function resolveAiResourceContext(env: Pick<Env, 'DB'>, context: AiResourceContext): Promise<AiResourceContext> {
  let userId = context.userId, projectId = context.projectId;
  if (context.jobId && (!userId || !projectId)) {
    const job = await env.DB.prepare('SELECT project_id,input_json,created_by FROM jobs WHERE id=?1').bind(context.jobId).first<{project_id:string|null;input_json:string;created_by:string|null}>();
    if (job) {
      projectId ??= job.project_id;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(job.input_json) as Record<string, unknown>; } catch { /* Legacy malformed input cannot select an actor. */ }
      if (typeof input.requestedBy === 'string') userId ??= input.requestedBy;
      userId ??= job.created_by;
      if (!userId && typeof input.draftId === 'string') userId = (await env.DB.prepare('SELECT owner_id FROM project_creation_drafts WHERE id=?1').bind(input.draftId).first<{owner_id:string}>())?.owner_id;
    }
  }
  if (!userId && context.draftAttemptId) userId = (await env.DB.prepare('SELECT owner_id FROM project_creation_drafts WHERE preview_attempt_id=?1').bind(context.draftAttemptId).first<{owner_id:string}>())?.owner_id;
  // Automatic project work without a recorded initiating actor belongs to the current owner.
  if (!userId && projectId) userId = (await env.DB.prepare("SELECT user_id created_by FROM project_members WHERE project_id=?1 AND role='owner' ORDER BY joined_at,user_id LIMIT 1").bind(projectId).first<{created_by:string}>())?.created_by;
  return { ...context, userId, projectId };
}

/** One INSERT + count triggers is the admission transaction; no read/check/write quota race. */
export async function claimAiResource(env: QuotaEnv, context: AiResourceContext, options: {dispatchKey?:string;leaseUntil?:string} = {}): Promise<AiResourceClaim> {
  const scope = await resolveAiResourceContext(env, context), id = newId(), key = options.dispatchKey ?? id, day = aiQuotaDay(), now = nowIso();
  if(env.ENV_NAME==='production'&&!scope.userId)throw new AppError('PERMISSION_DENIED','模型请求缺少已授权的调用者，未发起请求',403,false,{resourceQuota:true,automaticRetry:false});
  const counters = [['platform', 'global'], ...(scope.userId ? [['user', scope.userId]] : []), ...(scope.projectId ? [['project', scope.projectId]] : [])];
  const results = await env.DB.batch([
    ...counters.map(([kind, scopeId]) => env.DB.prepare('INSERT OR IGNORE INTO ai_resource_daily(quota_day,scope,scope_id,calls) VALUES(?1,?2,?3,0)').bind(day,kind,scopeId)),
    env.DB.prepare(`INSERT OR IGNORE INTO ai_resource_dispatches(id,dispatch_key,quota_day,user_id,project_id,operation,target_id,model,status,lease_until,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?11,?12,'claimed',?7,?8 FROM resource_policy p WHERE p.id=1
      AND json_extract(p.policy_json,'$.aiEnabled')=1
      AND (?5 IS NULL OR EXISTS(SELECT 1 FROM project_members WHERE project_id=?5 AND user_id=?4))
      AND (SELECT calls FROM ai_resource_daily WHERE quota_day=?3 AND scope='platform' AND scope_id='global')<json_extract(p.policy_json,'$.platformDailyCalls')
      AND (?4 IS NULL OR (SELECT calls FROM ai_resource_daily WHERE quota_day=?3 AND scope='user' AND scope_id=?4)<json_extract(p.policy_json,'$.userDailyCalls'))
      AND (?5 IS NULL OR (SELECT calls FROM ai_resource_daily WHERE quota_day=?3 AND scope='project' AND scope_id=?5)<json_extract(p.policy_json,'$.projectDailyCalls'))
      AND (?9=0 OR (EXISTS(SELECT 1 FROM storage_inventory_state WHERE id=1 AND ready=1 AND external_checked_at>=?10)
        AND COALESCE((SELECT bytes FROM storage_counters WHERE scope='platform' AND scope_id='all'),0)<MAX(0,json_extract(p.policy_json,'$.platformStorageBytes')-json_extract(p.policy_json,'$.externalStorageBytes'))))
      AND (SELECT COUNT(*) FROM ai_resource_dispatches WHERE status IN('claimed','uncertain') AND (lease_until IS NULL OR lease_until>?8))<json_extract(p.policy_json,'$.globalConcurrency')`)
      .bind(id,key,day,scope.userId??null,scope.projectId??null,scope.operation??'model',options.leaseUntil??null,now,env.ENV_NAME==='production'?1:0,new Date(Date.now()-86_400_000).toISOString(),scope.jobId??scope.draftAttemptId??scope.requestId??null,scope.model??null),
  ]);
  if (results.at(-1)?.meta.changes) return { id };
  if (await env.DB.prepare('SELECT 1 FROM ai_resource_dispatches WHERE dispatch_key=?1').bind(key).first()) throw invalidState('模型请求已登记，不能重复发出；请先核对原请求结果');
  if(scope.projectId&&!await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(scope.projectId,scope.userId??null).first())throw new AppError('PERMISSION_DENIED','调用者已不是当前项目成员，未发起模型请求',403,false,{resourceQuota:true,automaticRetry:false});
  const policy = await loadResourcePolicy(env);
  if (!policy.aiEnabled) throw new AppError('AI_UNAVAILABLE','平台已暂停 AI 请求，请等待管理员恢复',503,false,{resourceQuota:true,automaticRetry:false});
  if(env.ENV_NAME==='production'){
    const inventory=await env.DB.prepare('SELECT ready,external_checked_at FROM storage_inventory_state WHERE id=1').first<{ready:number;external_checked_at:string|null}>();
    if(!inventory?.ready||!inventory.external_checked_at||Date.parse(inventory.external_checked_at)<Date.now()-86_400_000)throw new AppError('QUOTA_EXCEEDED','生产存储尚未完成库存或其他资源核对，暂不发起付费 AI 请求',429,false,{resourceQuota:true,storageInventoryRequired:true,automaticRetry:false});
    const occupied=(await env.DB.prepare("SELECT bytes FROM storage_counters WHERE scope='platform' AND scope_id='all'").first<{bytes:number}>())?.bytes??0;
    if(occupied>=Math.max(0,policy.platformStorageBytes-policy.externalStorageBytes))throw new AppError('QUOTA_EXCEEDED','平台存储已满，暂不发起付费 AI 请求',429,false,{resourceQuota:true,storageQuota:true,automaticRetry:false});
  }
  const rows = await env.DB.prepare("SELECT scope,scope_id,calls FROM ai_resource_daily WHERE quota_day=?1 AND ((scope='platform' AND scope_id='global') OR (scope='user' AND scope_id=?2) OR (scope='project' AND scope_id=?3))").bind(day,scope.userId??null,scope.projectId??null).all<{scope:string;scope_id:string;calls:number}>();
  const used = (kind:string,scopeId:string|null|undefined) => rows.results.find(row=>row.scope===kind&&row.scope_id===scopeId)?.calls??0;
  const scopeName = scope.userId && used('user',scope.userId)>=policy.userDailyCalls ? '用户' : scope.projectId && used('project',scope.projectId)>=policy.projectDailyCalls ? '项目' : used('platform','global')>=policy.platformDailyCalls ? '平台' : null;
  if (scopeName) throw new AppError('QUOTA_EXCEEDED',`${scopeName}今日 AI 调用额度已用尽，北京时间次日零点恢复；继续处理也受此额度限制`,429,false,{resourceQuota:true,scope:scopeName,quotaDay:day,automaticRetry:false});
  if (context.jobId || context.draftAttemptId) throw new ResourceConcurrencyWait();
  throw new AppError('QUOTA_EXCEEDED','平台 AI 并发名额已满，请稍后重试；未发起模型请求',429,true,{resourceQuota:true,concurrency:true,retryAfterSeconds:60});
}

/** Only cancellation before outbound dispatch refunds the day. Unknown acceptance holds its slot until evidence. */
export async function finishAiResource(env: Pick<Env, 'DB'>, claim: AiResourceClaim, outcome: 'completed'|'uncertain'|'cancelled') {
  await env.DB.prepare(`UPDATE ai_resource_dispatches SET status=?2,completed_at=?3,lease_until=CASE WHEN ?2='uncertain' THEN NULL ELSE lease_until END
    WHERE id=?1 AND status='claimed'`).bind(claim.id,outcome,nowIso()).run();
}
export async function assertAiResourceEnabled(env: Pick<Env,'DB'>) {
  if (!(await loadResourcePolicy(env)).aiEnabled) throw new AppError('AI_UNAVAILABLE','平台已暂停 AI 请求',503,false,{resourceQuota:true,automaticRetry:false});
}
/** An operator must establish provider completion first; daily attempts are never refunded. */
export async function releaseAiResourceWithEvidence(env:Pick<Env,'DB'>,id:string,actorId:string,reason:string){
  const auditId=newId(),now=nowIso();
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE ai_resource_dispatches SET status='completed',completed_at=?2 WHERE id=?1 AND status IN('claimed','uncertain') AND EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=?3 AND account_role='super_admin' AND password_hash IS NOT NULL)").bind(id,now,actorId),
    env.DB.prepare("INSERT INTO ai_resource_release_audit(id,dispatch_id,actor_id,reason,created_at) SELECT ?1,?2,?3,?4,?5 WHERE changes()=1").bind(auditId,id,actorId,reason,now),
  ]);
  if(!results[0]?.meta.changes){if(!await env.DB.prepare("SELECT 1 FROM auth_accounts WHERE user_id=?1 AND account_role='super_admin' AND password_hash IS NOT NULL").bind(actorId).first())throw new AppError('PERMISSION_DENIED','超级管理员权限已撤销，未释放并发名额',403,false);throw invalidState('此并发名额已释放或请求不存在');}
  return {id,status:'completed' as const};
}
/** Wrap only a real paid request; cached provider envelopes must bypass this function. */
export async function withAiResourceDispatch<T>(env: QuotaEnv, context: AiResourceContext, request:()=>Promise<T>, options:{dispatchKey?:string;leaseUntil?:string}={}):Promise<T> {
  const claim=await claimAiResource(env,context,options);
  try { const value=await request(); await finishAiResource(env,claim,'completed'); return value; }
  catch(error) { const known=error instanceof AppError && !error.details?.acceptanceUncertain && (typeof error.details?.status==='number'||error.code==='AI_OUTPUT_INVALID'); await finishAiResource(env,claim,error instanceof AppError&&error.details?.resourceQuota?'cancelled':known?'completed':'uncertain'); throw error; }
}
