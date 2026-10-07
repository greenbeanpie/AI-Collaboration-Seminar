import { readExecution, resolveExecutionTarget } from './ai-execution-control';
import { recordActivity } from './ai-activity';
import type { Env } from '../env';
import { AppError, invalidState } from '../core/errors';
import { newId, nowIso } from '../core/db';
import { loadAiConfig } from '../ai/config';
import { loadDraftCheckpoint, saveDraftCheckpoint } from './draft-preview-checkpoints';
import { dispatchDraftPreview, enqueueDraftPreview } from './draft-preview-jobs';

export const AUTOMATIC_AI_RETRY_LIMIT = 3;
export const AUTOMATIC_AI_RETRY_DELAY_MS = 60_000;
interface RetryRow { id:string; target_kind:'job'|'draft_preview';target_id:string;draft_id:string|null;attempts:number;status:string;next_attempt_at:string;lease_token:string|null }
export function isAutomaticAiFailure(code:string):boolean {
  return code === 'AI_UNAVAILABLE' || code === 'AI_OUTPUT_INVALID' || code === 'ASSESSMENT_FAILED';
}

/** Prepared insert belongs in the same transaction as the exact failed transition. */
export function prepareAutomaticJobRetry(env:Env,jobId:string,error:{code:string;message:string;details?:unknown},failedAt:string):D1PreparedStatement|null {
  if(error.details && typeof error.details==='object' && 'automaticRetry' in error.details && error.details.automaticRetry===false)return null;
  if(!isAutomaticAiFailure(error.code)) return null;
  const due=new Date(Date.parse(failedAt)+AUTOMATIC_AI_RETRY_DELAY_MS).toISOString();
  return env.DB.prepare(`INSERT INTO ai_automatic_retries(id,target_kind,target_id,status,next_attempt_at,last_error,created_at,updated_at)
    SELECT COALESCE(json_extract(input_json,'$.autoRetryRootId'),'job:'||id),'job',id,'pending',?3,?4,?2,?2
    FROM jobs WHERE id=?1 AND status='failed' AND updated_at=?2 AND error_json=?5
      AND kind IN ('agent_run','review_run','rehearsal_turn','assignment_suggest','requirement_extract','parse_source','ocr_pages')
      AND COALESCE(json_extract(input_json,'$.mediaProvider'),'')!='mimo'
      AND NOT EXISTS(SELECT 1 FROM media_processing WHERE job_id=jobs.id AND provider='mimo')
      AND NOT EXISTS(SELECT 1 FROM ai_task_activities WHERE target_id=jobs.id AND uncertain=1)
      AND NOT EXISTS(SELECT 1 FROM ai_executions e WHERE e.target_kind='job' AND e.target_id IN (jobs.id,REPLACE(COALESCE(json_extract(jobs.input_json,'$.autoRetryRootId'),''),'job:','')) AND e.state IN ('paused','finalizing','cancelled','completed'))
    ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,
      status=CASE WHEN attempts>=3 THEN 'exhausted' ELSE 'pending' END,
      next_attempt_at=excluded.next_attempt_at,last_error=excluded.last_error,lease_token=NULL,lease_until=NULL,updated_at=excluded.updated_at
    WHERE ai_automatic_retries.status IN ('dispatching','dispatched')`)
    .bind(jobId,failedAt,due,error.message.slice(0,500),JSON.stringify(error));
}
/** Standalone scheduling verifies the stored failure before inserting. */
export async function scheduleAutomaticJobRetry(env:Env,jobId:string,error:{code:string;message:string;details?:unknown}):Promise<void> {
  if(!isAutomaticAiFailure(error.code)) return;
  const job=await env.DB.prepare("SELECT updated_at FROM jobs WHERE id=?1 AND status='failed'").bind(jobId).first<{updated_at:string}>();
  if(!job) return;
  await prepareAutomaticJobRetry(env,jobId,error,job.updated_at)?.run();
}
export async function scheduleAutomaticDraftRetry(env:Env,draftId:string,attemptId:string,error:unknown):Promise<void> {
  if(!(error instanceof AppError) || !isAutomaticAiFailure(error.code)) return;
  const draft=await env.DB.prepare("SELECT 1 FROM project_creation_drafts WHERE id=?1 AND preview_attempt_id=?2 AND status='active' AND preview_state='failed' AND preview_waiting_id IS NULL").bind(draftId,attemptId).first();
  if(draft) await schedule(env,{id:`draft:${attemptId}`,kind:'draft_preview',target:attemptId,draftId},error.message);
}
async function schedule(env:Env,target:{id:string;kind:string;target:string;draftId?:string},message:string):Promise<void> {
  const now=nowIso(),due=new Date(Date.now()+AUTOMATIC_AI_RETRY_DELAY_MS).toISOString();
  await env.DB.prepare(`INSERT INTO ai_automatic_retries(id,target_kind,target_id,draft_id,status,next_attempt_at,last_error,created_at,updated_at)
    VALUES(?1,?2,?3,?4,'pending',?5,?6,?7,?7)
    ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,
      status=CASE WHEN attempts>=3 THEN 'exhausted' ELSE 'pending' END,
      next_attempt_at=excluded.next_attempt_at,last_error=excluded.last_error,lease_token=NULL,lease_until=NULL,updated_at=excluded.updated_at
    WHERE ai_automatic_retries.status IN ('dispatching','dispatched')`)
    .bind(target.id,target.kind,target.target,target.draftId??null,due,message.slice(0,500),now).run();
}

/** Preserve completed reads and outputs; only an unanswered paid dispatch is replaced. */
async function resumeDraftPreview(env:Env,row:RetryRow,allowUncertain=false):Promise<void> {
  const draft=await env.DB.prepare('SELECT owner_id,revision,preview_state,preview_attempt_id,preview_config_version_id,status,preview_waiting_id FROM project_creation_drafts WHERE id=?1').bind(row.draft_id).first<{owner_id:string;revision:number;preview_state:string;preview_attempt_id:string|null;preview_config_version_id:string|null;status:string;preview_waiting_id:string|null}>();
  if(!draft || draft.status!=='active' || draft.preview_attempt_id!==row.target_id || draft.preview_waiting_id) throw invalidState('草稿预览已被替换、取消或正在等待回答');
  const config=await loadAiConfig(env.DB);
  if(!config?.enabled || config.id!==draft.preview_config_version_id) throw invalidState('模型配置已变化，请重新预览');
  const restored=await loadDraftCheckpoint(env,row.target_id);
  if(!restored || restored.checkpoint.revision!==draft.revision || restored.checkpoint.userId!==draft.owner_id) throw invalidState('草稿检查点已变化');
  const instanceId=`${row.target_id}-retry-${row.attempts}`;
  const existing=await env.DB.prepare('SELECT status FROM draft_preview_dispatches WHERE instance_id=?1').bind(instanceId).first<{status:string}>();
  if(existing?.status==='dispatched')return;
  if(restored.checkpoint.pendingDispatch&&!restored.checkpoint.pendingOutput&&!allowUncertain)throw invalidState('上次模型请求结果未知，请点击从停止处继续；该步骤可能再次计费');
  if(draft.preview_state==='failed') {
    // Do not discard pendingOutput/pendingResults: their tool calls may already have run.
    restored.checkpoint.pendingDispatch=false;
    await saveDraftCheckpoint(env,restored.checkpoint,restored.etag);
  } else if(draft.preview_state!=='running' || !existing) throw invalidState('预览状态已变化');
  const now=nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO draft_preview_dispatches(instance_id,draft_id,attempt_id,context_revision,status,created_at,updated_at) SELECT ?1,?2,?3,?4,'pending',?5,?5 WHERE EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?2 AND status='active' AND preview_attempt_id=?3 AND revision=?4 AND preview_state IN ('failed','running') AND preview_waiting_id IS NULL)").bind(instanceId,row.draft_id,row.target_id,draft.revision,now),
    env.DB.prepare("UPDATE project_creation_drafts SET preview_state='running',preview_error=NULL,updated_at=?4 WHERE id=?1 AND preview_attempt_id=?2 AND revision=?3 AND preview_state='failed' AND status='active' AND preview_waiting_id IS NULL AND EXISTS(SELECT 1 FROM draft_preview_dispatches WHERE instance_id=?5)").bind(row.draft_id,row.target_id,draft.revision,now,instanceId),
  ]);
  await recordActivity(env,'draft:'+row.target_id,'retrying','resumed',{completed:restored.checkpoint.step,unit:'step'});
  await dispatchDraftPreview(env,{instance_id:instanceId,draft_id:row.draft_id!,attempt_id:row.target_id,context_revision:draft.revision,question_id:null,status:'pending',updated_at:now});
}

/** Administrator retries share the same attempt ceiling as automatic requests. */
export async function retryFailedDraftPreview(env:Env,draftId:string,expectedUpdatedAt?:string):Promise<{status:'retried'|'skipped';jobId?:string;reason?:string}> {
  const draft=await env.DB.prepare("SELECT preview_attempt_id,updated_at FROM project_creation_drafts WHERE id=?1 AND status='active' AND preview_state='failed' AND preview_waiting_id IS NULL").bind(draftId).first<{preview_attempt_id:string|null;updated_at:string}>();
  if(!draft?.preview_attempt_id || (expectedUpdatedAt && expectedUpdatedAt!==draft.updated_at)) return {status:'skipped',reason:'草稿预览已变化'};
  const id=`draft:${draft.preview_attempt_id}`;
  await schedule(env,{id,kind:'draft_preview',target:draft.preview_attempt_id,draftId},'管理员排队重试');
  const stopped=await env.DB.prepare('SELECT status FROM ai_automatic_retries WHERE id=?1').bind(id).first<{status:string}>();
  if(stopped && ['exhausted','cancelled'].includes(stopped.status)) {
    const checkpoint=await loadDraftCheckpoint(env,draft.preview_attempt_id);
    const config=await loadAiConfig(env.DB);
    if(!checkpoint || !config?.enabled || config.id!==checkpoint.checkpoint.configVersionId) return {status:'skipped',reason:'预览模型配置已变化'};
    const refreshed=await enqueueDraftPreview(env,draftId,checkpoint.checkpoint.userId,checkpoint.checkpoint.revision,[],true,checkpoint.checkpoint.requestedGoal);
    return {status:'retried',jobId:refreshed.previewAttemptId ?? undefined};
  }
  const token=newId(),now=nowIso();
  const claim=await env.DB.prepare("UPDATE ai_automatic_retries SET attempts=attempts+1,status='dispatching',lease_token=?2,lease_until=?3,updated_at=?4 WHERE id=?1 AND status='pending' AND attempts<3").bind(id,token,new Date(Date.now()+300_000).toISOString(),now).run();
  if(!claim.meta.changes)return {status:'skipped',reason:'已达三次重试上限或正在重试'};
  const row=(await env.DB.prepare('SELECT * FROM ai_automatic_retries WHERE id=?1').bind(id).first<RetryRow>())!;
  try {
    await resumeDraftPreview(env,row,true);
    await env.DB.prepare("UPDATE ai_automatic_retries SET status='dispatched',lease_token=NULL,lease_until=NULL,updated_at=?3 WHERE id=?1 AND lease_token=?2").bind(id,token,nowIso()).run();
    return {status:'retried',jobId:row.target_id};
  } catch(error) {
    await env.DB.prepare("UPDATE ai_automatic_retries SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error=?3,updated_at=?4 WHERE id=?1 AND lease_token=?2").bind(id,token,error instanceof Error?error.message.slice(0,500):'草稿重试失败',nowIso()).run();
    throw error;
  }
}

export type AutomaticJobRetry = (env:Env,jobId:string,rootId:string)=>Promise<{status?:string;jobId?:string;reason?:string}>;
/** Cron claims one chain once. Expired leases resume the same numbered attempt. */
export async function recoverAutomaticAiRetries(env:Env,retryJob:AutomaticJobRetry,limit=10):Promise<number> {
  const now=nowIso();
  const due=await env.DB.prepare("SELECT * FROM ai_automatic_retries WHERE (status='pending' AND attempts<3 AND next_attempt_at<=?1) OR (status='dispatching' AND lease_until<?1) ORDER BY next_attempt_at LIMIT ?2").bind(now,limit).all<RetryRow>();
  let dispatched=0;
  for(const row of due.results) {
    if(row.target_kind==='job'){
      const execution=await readExecution(env,await resolveExecutionTarget(env,{kind:'job',id:row.target_id}));
      if(execution&&['paused','finalizing','cancelled','completed'].includes(execution.state)){await env.DB.prepare("UPDATE ai_automatic_retries SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=?2 WHERE id=?1").bind(row.id,nowIso()).run();continue;}
    }
    const token=newId();
    const claimed=await env.DB.prepare("UPDATE ai_automatic_retries SET attempts=attempts+CASE WHEN status='pending' THEN 1 ELSE 0 END,status='dispatching',lease_token=?2,lease_until=?3,updated_at=?4 WHERE id=?1 AND ((status='pending' AND attempts<3 AND next_attempt_at<=?4) OR (status='dispatching' AND lease_until<?4))").bind(row.id,token,new Date(Date.now()+300_000).toISOString(),now).run();
    if(!claimed.meta.changes)continue;
    const active=(await env.DB.prepare('SELECT * FROM ai_automatic_retries WHERE id=?1 AND lease_token=?2').bind(row.id,token).first<RetryRow>())!;
    try {
      const result=active.target_kind==='job' ? await retryJob(env,active.target_id,active.id) : (await resumeDraftPreview(env,active),{jobId:active.target_id});
      if(!result.jobId || result.status==='skipped') throw invalidState(result.reason ?? '当前请求无法安全重试');
      // The failed child may already have scheduled its next attempt and cleared this lease.
      await env.DB.prepare("UPDATE ai_automatic_retries SET target_id=?3,status='dispatched',lease_token=NULL,lease_until=NULL,updated_at=?4 WHERE id=?1 AND lease_token=?2").bind(row.id,token,result.jobId,nowIso()).run();
      dispatched++;
    } catch(error) {
      if(error instanceof AppError && error.code==='QUOTA_EXCEEDED' && error.details?.limit){
        // Waiting for another job's slot is not a failed model recovery attempt.
        await env.DB.prepare("UPDATE ai_automatic_retries SET attempts=MAX(0,attempts-1),status='pending',next_attempt_at=?3,lease_token=NULL,lease_until=NULL,updated_at=?4 WHERE id=?1 AND lease_token=?2").bind(row.id,token,new Date(Date.now()+AUTOMATIC_AI_RETRY_DELAY_MS).toISOString(),nowIso()).run();
        continue;
      }
      const stop=error instanceof AppError && !isAutomaticAiFailure(error.code);
      await env.DB.prepare("UPDATE ai_automatic_retries SET status=CASE WHEN ?3=1 THEN 'cancelled' WHEN attempts>=3 THEN 'exhausted' ELSE 'pending' END,next_attempt_at=?4,last_error=?5,lease_token=NULL,lease_until=NULL,updated_at=?6 WHERE id=?1 AND lease_token=?2").bind(row.id,token,stop?1:0,new Date(Date.now()+AUTOMATIC_AI_RETRY_DELAY_MS).toISOString(),error instanceof Error?error.message.slice(0,500):'重试派发失败',nowIso()).run();
    }
  }
  // Finished and cancelled requests do not keep an actionable retry chain.
  await env.DB.prepare("UPDATE ai_automatic_retries SET status='complete',updated_at=?1 WHERE status='dispatched' AND target_kind='job' AND EXISTS(SELECT 1 FROM jobs WHERE id=target_id AND status='succeeded')").bind(nowIso()).run();
  await env.DB.prepare("UPDATE ai_automatic_retries SET status='complete',updated_at=?1 WHERE status='dispatched' AND target_kind='draft_preview' AND EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=draft_id AND preview_attempt_id=target_id AND preview_state='ready')").bind(nowIso()).run();
  return dispatched;
}
