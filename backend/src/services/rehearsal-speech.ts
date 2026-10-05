import type { Env } from '../env';
import { AppError, invalidState, notFound, permissionDenied } from '../core/errors';
import { nowIso } from '../core/db';
import { getJob, succeedJob } from './jobs';
import { settleReservation } from './budget';

type SpeechStatus='queued'|'running'|'ready'|'failed';
interface SpeechRow {id:string;job_id:string;status:SpeechStatus;r2_key:string|null;mime:string|null;error:string|null}
type SpeechAccess={projectId:string;rehearsalId:string;actorId:string};
export type SpeechReadParams=SpeechAccess&{speechId:string};
export const CLOUD_SPEECH_RETIRED_MESSAGE='云端朗读已退役，请使用系统本地朗读；不会发起云端语音合成请求';
export async function enqueueRehearsalSpeech(_env:Env,_params:SpeechAccess&{sequence:number}):Promise<never>{
 throw new AppError('INVALID_STATE',CLOUD_SPEECH_RETIRED_MESSAGE,410,false);
}
async function assertOwner(env:Env,params:SpeechAccess):Promise<void>{
 const row=await env.DB.prepare('SELECT created_by FROM rehearsals WHERE id=?1 AND project_id=?2').bind(params.rehearsalId,params.projectId).first<{created_by:string}>();
 if(!row)throw notFound('答辩演练不存在');
 if(row.created_by!==params.actorId||!await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(params.projectId,params.actorId).first())throw permissionDenied('仅仍在项目中的答辩发起人可读取历史朗读');
}
async function loadSpeech(env: Env, params: SpeechReadParams): Promise<SpeechRow> {
  await assertOwner(env, params);
  const row = await env.DB.prepare('SELECT * FROM rehearsal_speech WHERE id=?1 AND project_id=?2 AND rehearsal_id=?3 AND created_by=?4').bind(params.speechId,params.projectId,params.rehearsalId,params.actorId).first<SpeechRow>();
  if (!row) throw notFound('朗读音频不存在');
  return row;
}
export async function readRehearsalSpeech(env: Env, params: SpeechReadParams): Promise<{ speechId: string; status: SpeechStatus; audioPath?: string; error?: string }> {
  const row = await loadSpeech(env, params);
  const job = await getJob(env,row.job_id);
  if (row.status !== 'ready' && job.status === 'cancelled') return {speechId:row.id,status:'failed',error:'朗读任务已取消'};
  if (row.status !== 'ready' && job.status === 'failed') return {speechId:row.id,status:'failed',error:row.error ?? CLOUD_SPEECH_RETIRED_MESSAGE};
  return { speechId: row.id, status: row.status, ...(row.status === 'ready' && row.r2_key ? { audioPath: `/api/v1/projects/${params.projectId}/rehearsals/${params.rehearsalId}/speech/${row.id}/audio` } : {}), ...(row.error ? { error: row.error } : {}) };
}
export async function readRehearsalSpeechAudio(env: Env, params: SpeechReadParams): Promise<Response> {
  const row = await loadSpeech(env, params);
  if (row.status !== 'ready' || !row.r2_key) throw invalidState('朗读音频尚未就绪');
  const object = await env.FILES.get(row.r2_key); if (!object) throw notFound('朗读音频已不可用');
  await assertOwner(env, params);
  return new Response(object.body, { headers: { 'content-type': row.mime ?? 'audio/wav', 'content-length': String(object.size), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}

/** Retired jobs must never re-enter a paid retry path. */
export async function assertRehearsalSpeechRetry(_env:Env,_oldJobId:string,_actorId:string):Promise<never>{throw new AppError('INVALID_STATE',CLOUD_SPEECH_RETIRED_MESSAGE,410,false);}

/** Retire before clearing leases: old workers then cannot publish a late response. */
export async function runRehearsalSpeechJob(env:Env,jobId:string):Promise<void>{
 const job=await getJob(env,jobId);
 if((JSON.parse(job.input_json) as {operation?:string}).operation!=='rehearsal.tts')return;
 const ready=await env.DB.prepare("SELECT id FROM rehearsal_speech WHERE job_id=?1 AND status='ready'").bind(jobId).first<{id:string}>();
 if(ready){
   if(['queued','running'].includes(job.status))await succeedJob(env,jobId,{speechId:ready.id,historical:true});
   await settleReservation(env,jobId,'settled');return;
 }
 const now=nowIso();
 await env.DB.batch([
  env.DB.prepare("UPDATE jobs SET status='cancelled',finished_at=?2,updated_at=?2,error_json=?3 WHERE id=?1 AND status IN ('queued','running','waiting_input') AND json_extract(input_json,'$.operation')='rehearsal.tts'").bind(jobId,now,JSON.stringify({code:'INVALID_STATE',message:CLOUD_SPEECH_RETIRED_MESSAGE})),
  env.DB.prepare("UPDATE rehearsal_speech SET status='failed',error=?2,lease_token=NULL,lease_expires_at=NULL,updated_at=?3 WHERE job_id=?1 AND status IN ('queued','running') AND EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status IN ('cancelled','failed'))").bind(jobId,CLOUD_SPEECH_RETIRED_MESSAGE,now),
  env.DB.prepare("UPDATE job_outbox SET status='failed',lease_until=NULL,last_error='CLOUD_SPEECH_RETIRED',updated_at=?2 WHERE job_id=?1 AND status IN ('pending','dispatched') AND EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status IN ('cancelled','failed'))").bind(jobId,now),
 ]);
 // released keeps paid/uncertain calls as settled or pending_reconcile; no ledger deletion.
 await settleReservation(env,jobId,'released');
}
export async function retireCloudRehearsalSpeechJobs(env:Env,limit=50):Promise<void>{
 const jobs=await env.DB.prepare("SELECT id FROM jobs WHERE json_extract(input_json,'$.operation')='rehearsal.tts' AND (status IN ('queued','running','waiting_input') OR EXISTS(SELECT 1 FROM usage_reservations WHERE job_id=jobs.id AND status='reserved')) ORDER BY updated_at LIMIT ?1").bind(Math.max(1,Math.min(50,limit))).all<{id:string}>();
 for(const job of jobs.results)await runRehearsalSpeechJob(env,job.id);
}
