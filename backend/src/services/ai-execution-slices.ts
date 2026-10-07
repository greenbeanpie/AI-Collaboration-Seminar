import { AppError } from '../core/errors';
import { isExecutionPaused } from './ai-execution-control';
import type { Env } from '../env';
import { InvestigationContinuation } from './project-investigation';
import { nowIso } from '../core/db';

export class BackgroundContinuation extends Error { constructor(message='已保存后台处理检查点，将在独立实例继续'){super(message);this.name='BackgroundContinuation';} }
export function isBackgroundContinuation(error:unknown):boolean {return error instanceof BackgroundContinuation || error instanceof InvestigationContinuation || error instanceof AppError&&error.details?.executionSuperseded===true;}

export interface ExecutionSlice { job_id:string; slice:number; instance_id:string; status:string }
export async function activeExecutionSlice(env:Env,jobId:string):Promise<ExecutionSlice|null>{
  return env.DB.prepare('SELECT job_id,slice,instance_id,status FROM ai_execution_slices WHERE job_id=?1 ORDER BY slice DESC LIMIT 1').bind(jobId).first<ExecutionSlice>();
}
export async function ensureInitialExecutionSlice(env:Env,jobId:string):Promise<void>{
  const now=nowIso();
  await env.DB.prepare("INSERT OR IGNORE INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) SELECT id,0,id,'pending',?2,?2 FROM jobs WHERE id=?1 AND status='running'").bind(jobId,now).run();
}
/** Deterministic IDs recover ambiguous create responses without executing twice. */
export async function dispatchExecutionSlice(env:Env,row:ExecutionSlice):Promise<boolean>{
  const active=await activeExecutionSlice(env,row.job_id);
  if(!active || active.slice!==row.slice || active.status!=='pending') return false;
  const job=await env.DB.prepare('SELECT status,kind FROM jobs WHERE id=?1').bind(row.job_id).first<{status:string;kind:string}>();
  if(job?.status!=='running') return false;
  try{
    const workflow=env.AGENT_WORKFLOW;
    await workflow.create({id:row.instance_id,params:{jobId:row.job_id,...(row.slice ? {slice:row.slice} : {})}});
  }catch(error){
    if(!(error instanceof Error) || !error.message.includes('already exists')){
      await env.DB.prepare("UPDATE ai_execution_slices SET attempts=attempts+1,last_error=?3,updated_at=?4 WHERE job_id=?1 AND slice=?2 AND status='pending'").bind(row.job_id,row.slice,error instanceof Error?error.message:String(error),nowIso()).run();
      return false;
    }
  }
  await env.DB.prepare("UPDATE ai_execution_slices SET status='dispatched',attempts=attempts+1,last_error=NULL,updated_at=?3 WHERE job_id=?1 AND slice=?2 AND status='pending'").bind(row.job_id,row.slice,nowIso()).run();
  return true;
}
/** Claim once, including on engine replay. An uncertain paid slice is never retried. */
export async function claimExecutionSlice(env:Env,jobId:string,slice:number):Promise<boolean>{
  const result=await env.DB.prepare("UPDATE ai_execution_slices SET status='running',updated_at=?3 WHERE job_id=?1 AND slice=?2 AND status IN ('pending','dispatched') AND NOT EXISTS(SELECT 1 FROM ai_execution_slices newer WHERE newer.job_id=?1 AND newer.slice>?2) AND EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status='running')").bind(jobId,slice,nowIso()).run();
  return !!result.meta.changes;
}
/** Called only after a durable safe checkpoint. Atomically advance the active pointer. */
export async function continueExecutionSlice(env:Env,jobId:string,slice:number):Promise<void>{
  const now=nowIso(),next=slice+1;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) SELECT ?1,?3,?4,'pending',?5,?5 WHERE EXISTS(SELECT 1 FROM ai_execution_slices WHERE job_id=?1 AND slice=?2 AND status='running') AND EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status='running')").bind(jobId,slice,next,`${jobId}-s${next}`,now),
    env.DB.prepare("UPDATE ai_execution_slices SET status='continued',updated_at=?3 WHERE job_id=?1 AND slice=?2 AND status='running' AND EXISTS(SELECT 1 FROM ai_execution_slices next WHERE next.job_id=?1 AND next.slice=?2+1)").bind(jobId,slice,now),
    env.DB.prepare("UPDATE jobs SET updated_at=?3 WHERE id=?1 AND status='running' AND EXISTS(SELECT 1 FROM ai_execution_slices WHERE job_id=?1 AND slice=?2+1)").bind(jobId,slice,now),
  ]);
  const active=await activeExecutionSlice(env,jobId);
  if(active?.slice===next) await dispatchExecutionSlice(env,active);
}
export async function completeExecutionSlice(env:Env,jobId:string,slice:number):Promise<void>{
  await env.DB.prepare("UPDATE ai_execution_slices SET status='complete',updated_at=?3 WHERE job_id=?1 AND slice=?2 AND status='running'").bind(jobId,slice,nowIso()).run();
}
export async function recoverExecutionSlices(env:Env):Promise<void>{
  const rows=await env.DB.prepare("SELECT s.job_id,s.slice,s.instance_id,s.status FROM ai_execution_slices s JOIN jobs j ON j.id=s.job_id WHERE s.status='pending' AND j.status='running' AND NOT EXISTS(SELECT 1 FROM ai_execution_slices newer WHERE newer.job_id=s.job_id AND newer.slice>s.slice) ORDER BY s.updated_at LIMIT 10").all<ExecutionSlice>();
  for(const row of rows.results) await dispatchExecutionSlice(env,row);
}
export async function executeAiSlice(env:Env,jobId:string,slice:number,run:()=>Promise<void>):Promise<void>{
  if(!await claimExecutionSlice(env,jobId,slice)) return;
  try{
    await run();
    await completeExecutionSlice(env,jobId,slice);
  }catch(error){
    if(error instanceof AppError&&error.details?.executionSuperseded===true){await completeExecutionSlice(env,jobId,slice);return;}
    if(isExecutionPaused(error)){
      const execution=error.execution;
      // One SQL statement prevents a late pause handler from releasing a resumed window's slot.
      await env.DB.prepare("UPDATE usage_reservations SET status=CASE WHEN attempts_started=0 THEN 'released' ELSE 'settled' END,settled_at=?2 WHERE job_id=?1 AND status='reserved' AND EXISTS(SELECT 1 FROM ai_executions e WHERE e.target_kind='job' AND e.generation=?3 AND e.state='paused' AND (e.target_id=?1 OR e.target_id=(SELECT REPLACE(json_extract(input_json,'$.autoRetryRootId'),'job:','') FROM jobs WHERE id=?1) OR e.target_id IN (WITH RECURSIVE parents(id) AS (SELECT ?1 UNION SELECT l.parent_job_id FROM admin_ai_retry_links l JOIN parents ON l.retry_job_id=parents.id) SELECT id FROM parents)))").bind(jobId,nowIso(),execution.generation).run();
      await completeExecutionSlice(env,jobId,slice);return;
    }
    if(!isBackgroundContinuation(error)) throw error;
    await continueExecutionSlice(env,jobId,slice);
  }
}

/** A user action always gets a fresh deterministic instance; a completed engine is never replayed. */
export async function dispatchResumedExecution(env:Env,jobId:string):Promise<void>{
  const active=await activeExecutionSlice(env,jobId),next=(active?.slice??-1)+1,now=nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_execution_slices SET status='continued',updated_at=?2 WHERE job_id=?1 AND status IN ('running','pending','dispatched')").bind(jobId,now),
    env.DB.prepare("INSERT OR IGNORE INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) SELECT ?1,?2,?3,'pending',?4,?4 WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status='running')").bind(jobId,next,`${jobId}-s${next}`,now),
  ]);
  const resumed=await activeExecutionSlice(env,jobId);if(resumed)await dispatchExecutionSlice(env,resumed);
}
