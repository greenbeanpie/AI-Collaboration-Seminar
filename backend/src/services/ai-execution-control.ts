import {z} from '@hono/zod-openapi';
import type {Env} from '../env';
import {AppError, invalidState, notFound, validationFailed, versionConflict} from '../core/errors';
import {newId, nowIso} from '../core/db';
import type {AiExecutionPolicy, ExecutionPauseReason, ExecutionState, ExecutionTarget, ExecutionView} from '../../../shared/ai-execution';
export type {ExecutionTarget, ExecutionView, ExecutionPauseReason} from '../../../shared/ai-execution';
interface Row { generation:number;window_calls:number;total_calls:number;call_limit:number;state:ExecutionState;pause_reason:ExecutionPauseReason|null;inflight_token:string|null;draft_id:string|null }
export interface ExecutionCallToken { id:string; generation:number }
export class ExecutionPaused extends AppError {
  constructor(readonly execution:ExecutionView) {super('INVALID_STATE',execution.pauseReason==='request_uncertain'?'模型请求结果未知，处理已暂停':'AI 处理已暂停',409,false,{executionPause:true,automaticRetry:false,execution});this.name='ExecutionPaused';}
}
export const isExecutionPaused=(error:unknown):error is ExecutionPaused=>error instanceof ExecutionPaused || (error instanceof AppError && error.details?.executionPause===true);
const view=(r:Row):ExecutionView=>({generation:r.generation,windowCalls:r.window_calls,totalCalls:r.total_calls,limit:r.call_limit,state:r.state,pauseReason:r.pause_reason,canContinue:r.state==='paused' && r.pause_reason!=='request_uncertain',canOutput:r.state==='paused' && r.pause_reason!=='request_uncertain'});
const row=(env:Env,t:ExecutionTarget)=>env.DB.prepare('SELECT * FROM ai_executions WHERE target_kind=?1 AND target_id=?2').bind(t.kind,t.id).first<Row>();
export async function readExecution(env:Env,t:ExecutionTarget):Promise<ExecutionView|null>{const r=await row(env,t);return r?view(r):null;}
export async function loadExecutionPolicy(env:Env):Promise<AiExecutionPolicy>{const r=await env.DB.prepare("SELECT version,max_model_calls FROM ai_execution_policy WHERE id='global'").first<{version:number;max_model_calls:number}>();return {version:r?.version??1,maxModelCalls:r?.max_model_calls??100};}
export async function saveExecutionPolicy(env:Env,expectedVersion:number,maxModelCalls:number,actorId:string|null):Promise<AiExecutionPolicy>{
 if(!Number.isInteger(expectedVersion)||expectedVersion<1||!Number.isInteger(maxModelCalls)||maxModelCalls<1||maxModelCalls>10000)throw validationFailed('调用次数必须为 1–10000 的整数');
 const current=await loadExecutionPolicy(env);if(current.version!==expectedVersion)throw versionConflict(current.version);
 const id=newId(),now=nowIso();await env.DB.batch([
 env.DB.prepare("UPDATE ai_execution_policy SET version=version+1,max_model_calls=?2,updated_at=?3 WHERE id='global' AND version=?1").bind(expectedVersion,maxModelCalls,now),
 env.DB.prepare("INSERT INTO ai_execution_policy_audit(id,actor_id,version,max_model_calls,created_at) SELECT ?1,?2,version,max_model_calls,?3 FROM ai_execution_policy WHERE id='global' AND changes()=1").bind(id,actorId,now)]);
 const audit=await env.DB.prepare('SELECT version FROM ai_execution_policy_audit WHERE id=?1').bind(id).first<{version:number}>();if(!audit)throw versionConflict((await loadExecutionPolicy(env)).version);
 return {version:audit.version,maxModelCalls};
}
export async function ensureExecution(env:Env,t:ExecutionTarget,options:{draftId?:string;userId?:string}={}):Promise<ExecutionView>{const p=await loadExecutionPolicy(env);const now=nowIso();await env.DB.prepare('INSERT OR IGNORE INTO ai_executions(target_kind,target_id,draft_id,call_limit,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(t.kind,t.id,options.draftId??null,p.maxModelCalls,now).run();return (await readExecution(env,t))!;}
/** Call immediately before dispatch. Compare-and-swap grants one live request only. */
export async function acquireExecutionCall(env:Env,t:ExecutionTarget,expectedGeneration?:number):Promise<ExecutionCallToken>{
 await ensureExecution(env,t);const token={id:newId(),generation:0};const now=nowIso();
 const granted=await env.DB.prepare(`UPDATE ai_executions SET inflight_token=?3,inflight_generation=generation,window_calls=window_calls+1,total_calls=total_calls+1,final_call_used=CASE WHEN state='finalizing' THEN 1 ELSE final_call_used END,updated_at=?4 WHERE target_kind=?1 AND target_id=?2 AND inflight_token IS NULL AND (?5 IS NULL OR generation=?5) AND ((state='running' AND window_calls<call_limit) OR (state='finalizing' AND final_call_used=0)) RETURNING generation`).bind(t.kind,t.id,token.id,now,expectedGeneration??null).first<{generation:number}>();
 if(granted)return {...token,generation:granted.generation};
 const r=(await row(env,t))!;if(r.state==='running' && !r.inflight_token && r.window_calls>=r.call_limit){await pauseExecution(env,t,'round_limit');throw new ExecutionPaused((await readExecution(env,t))!);}
 if(r.state==='finalizing' && !r.inflight_token){await pauseExecution(env,t,'output_invalid');throw new ExecutionPaused((await readExecution(env,t))!);}
 if(r.state==='paused')throw new ExecutionPaused(view(r));throw invalidState(r.inflight_token?'已有模型请求正在处理':'当前执行状态不允许发出请求');
}
/** False means a cancelled or resumed generation must discard its late result. */
export async function finishExecutionCall(env:Env,t:ExecutionTarget,token:ExecutionCallToken,options:{uncertain?:boolean}={}):Promise<boolean>{
 const result=await env.DB.prepare(`UPDATE ai_executions SET inflight_token=NULL,inflight_generation=NULL,state=CASE WHEN ?5=1 THEN 'paused' ELSE state END,pause_reason=CASE WHEN ?5=1 THEN 'request_uncertain' ELSE pause_reason END,updated_at=?6 WHERE target_kind=?1 AND target_id=?2 AND inflight_token=?3 AND generation=?4 AND state IN ('running','finalizing')`).bind(t.kind,t.id,token.id,token.generation,options.uncertain?1:0,nowIso()).run();
 if(result.meta.changes && options.uncertain)await syncPausedTarget(env,t);return result.meta.changes>0;
}
async function syncPausedTarget(env:Env,t:ExecutionTarget){if(t.kind==='job')await env.DB.prepare(`WITH RECURSIVE descendants(id) AS (SELECT ?1 UNION SELECT retry_job_id FROM admin_ai_retry_links JOIN descendants ON parent_job_id=descendants.id UNION SELECT jobs.id FROM jobs JOIN descendants ON json_extract(jobs.input_json,'$.autoRetryRootId')='job:'||descendants.id) UPDATE jobs SET status='waiting_input',lease_until=NULL,updated_at=?2 WHERE id IN (SELECT id FROM descendants) AND status IN ('running','queued')`).bind(t.id,nowIso()).run();}
export async function pauseExecution(env:Env,t:ExecutionTarget,reason:ExecutionPauseReason):Promise<void>{await env.DB.prepare("UPDATE ai_executions SET state='paused',pause_reason=?3,updated_at=?4 WHERE target_kind=?1 AND target_id=?2 AND state IN ('running','finalizing') AND inflight_token IS NULL").bind(t.kind,t.id,reason,nowIso()).run();if((await readExecution(env,t))?.state==='paused')await syncPausedTarget(env,t);}
export async function resumeExecution(env:Env,t:ExecutionTarget,expectedGeneration:number,mode:'continue'|'output'):Promise<ExecutionView>{
 const p=await loadExecutionPolicy(env);const updated=await env.DB.prepare(`UPDATE ai_executions SET generation=generation+1,window_calls=0,call_limit=?4,state=?5,pause_reason=NULL,final_call_used=0,updated_at=?6 WHERE target_kind=?1 AND target_id=?2 AND generation=?3 AND state='paused' AND inflight_token IS NULL AND pause_reason<>'request_uncertain' RETURNING generation`).bind(t.kind,t.id,expectedGeneration,p.maxModelCalls,mode==='output'?'finalizing':'running',nowIso()).first();
 if(!updated){const r=await row(env,t);if(!r)throw notFound();if(r.generation!==expectedGeneration)throw versionConflict(r.generation);throw invalidState('该执行无法继续；请求结果未知时需要先确认供应商结果');}return (await readExecution(env,t))!;
}
export async function cancelExecution(env:Env,t:ExecutionTarget,expectedGeneration?:number):Promise<void>{const r=await row(env,t);if(!r)return;if(expectedGeneration!==undefined && r.generation!==expectedGeneration)throw versionConflict(r.generation);await env.DB.prepare("UPDATE ai_executions SET state='cancelled',inflight_token=NULL,inflight_generation=NULL,updated_at=?3 WHERE target_kind=?1 AND target_id=?2 AND generation=?4").bind(t.kind,t.id,nowIso(),r.generation).run();}
export async function completeExecution(env:Env,t:ExecutionTarget,expectedGeneration?:number):Promise<boolean>{const r=await row(env,t);if(!r)return false;const result=await env.DB.prepare("UPDATE ai_executions SET state='completed',pause_reason=NULL,updated_at=?3 WHERE target_kind=?1 AND target_id=?2 AND generation=?4 AND state IN ('running','finalizing') AND inflight_token IS NULL").bind(t.kind,t.id,nowIso(),expectedGeneration??r.generation).run();return result.meta.changes>0;}
/** Only call when dispatch is known not to have happened. */
export async function abortExecutionCall(env:Env,t:ExecutionTarget,token:ExecutionCallToken):Promise<boolean>{const result=await env.DB.prepare(`UPDATE ai_executions SET inflight_token=NULL,inflight_generation=NULL,window_calls=max(0,window_calls-1),total_calls=max(0,total_calls-1),final_call_used=CASE WHEN state='finalizing' THEN 0 ELSE final_call_used END,updated_at=?5 WHERE target_kind=?1 AND target_id=?2 AND inflight_token=?3 AND generation=?4 AND state IN ('running','finalizing')`).bind(t.kind,t.id,token.id,token.generation,nowIso()).run();return result.meta.changes>0;}
/** Retry jobs consume their original execution window rather than obtaining a new budget. */
export async function resolveExecutionTarget(env:Env,t:ExecutionTarget):Promise<ExecutionTarget>{
 if(t.kind!=='job')return t;let id=t.id;const seen=new Set<string>();
 while(!seen.has(id)){seen.add(id);const job=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1').bind(id).first<{input_json:string}>();let input:Record<string,unknown>={};try{input=JSON.parse(job?.input_json??'{}') as Record<string,unknown>;}catch{ /* malformed legacy input cannot redirect execution */ }
 const root=input.autoRetryRootId;if(typeof root==='string' && root.startsWith('job:') && root.slice(4)!==id){id=root.slice(4);continue;}
 const link=await env.DB.prepare('SELECT parent_job_id FROM admin_ai_retry_links WHERE retry_job_id=?1').bind(id).first<{parent_job_id:string}>();if(!link)break;id=link.parent_job_id;
 }return {kind:'job',id};
}

export const executionSchema=z.object({generation:z.number().int(),windowCalls:z.number().int(),totalCalls:z.number().int(),limit:z.number().int(),state:z.enum(['running','paused','finalizing','cancelled','completed']),pauseReason:z.enum(['round_limit','request_uncertain','output_invalid','interrupted']).nullable(),canContinue:z.boolean(),canOutput:z.boolean()});

/** Invoke only after the owning Workflow is confirmed terminal. Never clear live calls by age. */
export async function markInterruptedExecution(env:Env,t:ExecutionTarget,expectedGeneration:number):Promise<boolean>{
 const result=await env.DB.prepare("UPDATE ai_executions SET state='paused',pause_reason=CASE WHEN inflight_token IS NULL THEN 'interrupted' ELSE 'request_uncertain' END,inflight_token=NULL,inflight_generation=NULL,updated_at=?4 WHERE target_kind=?1 AND target_id=?2 AND generation=?3 AND state IN ('running','finalizing')").bind(t.kind,t.id,expectedGeneration,nowIso()).run();
 if(result.meta.changes)await syncPausedTarget(env,t);return result.meta.changes>0;
}
