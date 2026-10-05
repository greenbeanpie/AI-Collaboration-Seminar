import { z } from 'zod';
import type { Env } from '../env';
import { AppError, invalidState, notFound, permissionDenied } from '../core/errors';
import { newId, nowIso, sha256Hex } from '../core/db';
import { geminiSpeech, TTS_MODELS, TTS_VOICES } from '../ai/gemini-tts';
import { unseal } from '../ai/secrets';
import { recordAiCall } from '../ai/calls';
import { createJobAndDispatch, failJob, getJob, succeedJob } from './jobs';
import { markAiCallStarted, reserveAiSlot, settleReservation } from './budget';

type SpeechStatus = 'queued' | 'running' | 'ready' | 'failed';
interface SpeechRow {
  id: string; project_id: string; rehearsal_id: string; turn_id: string; sequence: number; created_by: string;
  content_hash: string; config_version_id: string; model: typeof TTS_MODELS[number]; voice: typeof TTS_VOICES[number];
  job_id: string; status: SpeechStatus; lease_token: string | null; lease_expires_at: string | null; dispatched_at: string | null;
  r2_key: string | null; mime: string | null; error: string | null;
}
interface SpeechJobInput { operation: 'rehearsal.tts'; speechId: string; rehearsalId: string; sequence: number; actorId: string; configVersionId: string; }
type SpeechAccess = { projectId: string; rehearsalId: string; actorId: string; };
export type SpeechReadParams = SpeechAccess & { speechId: string };
const voiceConfigSchema = z.object({
  realtimeAudioTranscription: z.object({ provider: z.literal('google-ai-studio'), model: z.literal('gemini-3.5-transcribe-live'), gatewayId: z.string().regex(/^[a-z0-9-]{1,64}$/), apiKeyEncrypted: z.string().min(1), gatewayTokenEncrypted: z.string().min(1) }),
  rehearsalSpeech: z.object({ model: z.enum(TTS_MODELS), voice: z.enum(TTS_VOICES) }).default({ model: 'gemini-3.8-flash-lite-tts', voice: 'Kore' }),
  processingStrategies: z.object({ rehearsal: z.literal('voice-with-text-fallback') }),
});

async function loadSpeechConfig(env: Env, configId?: string) {
  const row = await env.DB.prepare(configId ? 'SELECT id,config_json,enabled FROM ai_config_versions WHERE id=?1' : 'SELECT id,config_json,enabled FROM ai_config_versions ORDER BY version DESC LIMIT 1').bind(...(configId ? [configId] : [])).first<{ id: string; config_json: string; enabled: number }>();
  if (!row || row.enabled !== 1) throw new AppError('AI_UNAVAILABLE', 'AI 尚未启用', 503, false);
  const parsed = voiceConfigSchema.safeParse(JSON.parse(row.config_json));
  if (!parsed.success) throw new AppError('AI_UNAVAILABLE', '语音模式或 Gateway 凭据尚未配置', 503, false);
  return { id: row.id, ...parsed.data };
}

async function assertOwner(env: Env, params: SpeechAccess): Promise<void> {
  const row = await env.DB.prepare('SELECT created_by FROM rehearsals WHERE id=?1 AND project_id=?2').bind(params.rehearsalId, params.projectId).first<{ created_by: string }>();
  if (!row) throw notFound('答辩演练不存在');
  if (row.created_by !== params.actorId || !await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(params.projectId, params.actorId).first()) throw permissionDenied('仅仍在项目中的答辩发起人可使用语音');
}
async function currentTurn(env: Env, params: SpeechAccess & { sequence: number }) {
  await assertOwner(env, params);
  const row = await env.DB.prepare("SELECT t.id,t.content_json FROM rehearsals r JOIN rehearsal_turns t ON t.rehearsal_id=r.id WHERE r.id=?1 AND r.project_id=?2 AND r.status='active' AND r.finish_job_id IS NULL AND r.processing_job_id IS NULL AND t.sequence=?3 AND t.kind IN ('question','followup') AND t.sequence=(SELECT MAX(sequence) FROM rehearsal_turns WHERE rehearsal_id=r.id)").bind(params.rehearsalId, params.projectId, params.sequence).first<{ id: string; content_json: string }>();
  if (!row) throw invalidState('只能朗读当前已保存的问题或点评');
  const payload = JSON.parse(row.content_json) as { content?: unknown };
  if (typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 8000) throw invalidState('当前问题正文无效或超过朗读上限');
  return { id: row.id, content: payload.content, contentJson: row.content_json, hash: await sha256Hex(payload.content) };
}
const dto = (row: SpeechRow) => ({ jobId: row.job_id, speechId: row.id, status: row.status });

export async function enqueueRehearsalSpeech(env: Env, params: SpeechAccess & { sequence: number }): Promise<{ jobId: string; speechId: string; status: SpeechStatus }> {
  const turn = await currentTurn(env, params), config = await loadSpeechConfig(env);
  const speech = config.rehearsalSpeech;
  const cached = await env.DB.prepare('SELECT * FROM rehearsal_speech WHERE turn_id=?1 AND content_hash=?2 AND config_version_id=?3 AND model=?4 AND voice=?5').bind(turn.id, turn.hash, config.id, speech.model, speech.voice).first<SpeechRow>();
  if (cached) {
    const existingJob = await getJob(env,cached.job_id);
    return { ...dto(cached), ...(cached.status !== 'ready' && ['cancelled','failed'].includes(existingJob.status) ? { status: 'failed' as const } : {}) };
  }
  const id = newId(), jobId = newId(), now = nowIso();
  await reserveAiSlot(env, { projectId: params.projectId, jobId, purpose: 'rehearsal_speech', configVersionId: config.id, maxCalls: 2 });
  try {
    // Repeat the lifecycle predicate in the publication SQL after asynchronous budget reads.
    const saved = await env.DB.prepare(`INSERT OR IGNORE INTO rehearsal_speech(id,project_id,rehearsal_id,turn_id,sequence,created_by,content_hash,config_version_id,model,voice,job_id,status,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'queued',?12,?12
      WHERE EXISTS(SELECT 1 FROM rehearsals r JOIN rehearsal_turns t ON t.rehearsal_id=r.id WHERE r.id=?3 AND r.project_id=?2 AND r.created_by=?6 AND r.status='active' AND r.finish_job_id IS NULL AND r.processing_job_id IS NULL AND t.id=?4 AND t.content_json=?13 AND t.kind IN ('question','followup') AND t.sequence=(SELECT MAX(sequence) FROM rehearsal_turns WHERE rehearsal_id=r.id))
      AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6)`)
      .bind(id,params.projectId,params.rehearsalId,turn.id,params.sequence,params.actorId,turn.hash,config.id,speech.model,speech.voice,jobId,now,turn.contentJson).run();
    if (!saved.meta.changes) {
      await settleReservation(env, jobId, 'released');
      const winner = await env.DB.prepare('SELECT * FROM rehearsal_speech WHERE turn_id=?1 AND content_hash=?2 AND config_version_id=?3 AND model=?4 AND voice=?5').bind(turn.id,turn.hash,config.id,speech.model,speech.voice).first<SpeechRow>();
      if (winner) return dto(winner);
      throw invalidState('答辩问题已变化');
    }
    await createJobAndDispatch(env, { projectId: params.projectId, kind: 'agent_run', jobId, createdBy: params.actorId, input: { operation: 'rehearsal.tts', speechId: id, rehearsalId: params.rehearsalId, sequence: params.sequence, actorId: params.actorId, configVersionId: config.id } satisfies SpeechJobInput });
    return dto((await env.DB.prepare('SELECT * FROM rehearsal_speech WHERE id=?1').bind(id).first<SpeechRow>())!);
  } catch (error) {
    if (!await env.DB.prepare('SELECT id FROM jobs WHERE id=?1').bind(jobId).first()) {
      await env.DB.prepare('DELETE FROM rehearsal_speech WHERE id=?1 AND job_id=?2').bind(id,jobId).run();
      await settleReservation(env,jobId,'released');
    }
    throw error;
  }
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
  if (row.status !== 'ready' && job.status === 'failed') return {speechId:row.id,status:'failed',error:row.error ?? '朗读任务失败，等待统一重试'};
  return { speechId: row.id, status: row.status, ...(row.status === 'ready' && row.r2_key ? { audioPath: `/api/v1/projects/${params.projectId}/rehearsals/${params.rehearsalId}/speech/${row.id}/audio` } : {}), ...(row.error ? { error: row.error } : {}) };
}
export async function readRehearsalSpeechAudio(env: Env, params: SpeechReadParams): Promise<Response> {
  const row = await loadSpeech(env, params);
  if (row.status !== 'ready' || !row.r2_key) throw invalidState('朗读音频尚未就绪');
  const object = await env.FILES.get(row.r2_key); if (!object) throw notFound('朗读音频已不可用');
  await assertOwner(env, params);
  return new Response(object.body, { headers: { 'content-type': row.mime ?? 'audio/wav', 'content-length': String(object.size), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}

/** Used by retry orchestration before replacing job_id; ready artifacts are never reset. */
export async function assertRehearsalSpeechRetry(env: Env, oldJobId: string, actorId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM rehearsal_speech WHERE job_id=?1').bind(oldJobId).first<SpeechRow>();
  if (!row || row.status === 'ready') throw invalidState('朗读任务已变化或音频已就绪');
  const turn = await currentTurn(env, { projectId: row.project_id, rehearsalId: row.rehearsal_id, sequence: row.sequence, actorId });
  if (turn.id !== row.turn_id || turn.hash !== row.content_hash) throw invalidState('朗读正文已变化');
}

export async function runRehearsalSpeechJob(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  if (!['queued','running'].includes(job.status)) return;
  const input = JSON.parse(job.input_json) as SpeechJobInput;
  const row = await env.DB.prepare('SELECT * FROM rehearsal_speech WHERE id=?1 AND job_id=?2 AND project_id=?3').bind(input.speechId,jobId,job.project_id).first<SpeechRow>();
  if (!row) { await settleReservation(env,jobId,'released'); await failJob(env,jobId,{code:'INVALID_STATE',message:'朗读任务已变化'}); return; }
  if (row.status === 'ready') { await settleReservation(env,jobId,'settled'); await succeedJob(env,jobId,{speechId:row.id}); return; }
  if (row.status === 'running' && row.dispatched_at && row.lease_expires_at && row.lease_expires_at < nowIso()) {
    const changed = await env.DB.prepare("UPDATE rehearsal_speech SET status='failed',error='上次朗读请求受理状态未知；等待统一重试',lease_token=NULL,lease_expires_at=NULL WHERE id=?1 AND job_id=?2 AND status='running' AND lease_expires_at<?3").bind(row.id,jobId,nowIso()).run();
    if (changed.meta.changes) { await settleReservation(env,jobId,'released'); await failJob(env,jobId,{code:'AI_UNAVAILABLE',message:'上次朗读请求受理状态未知；等待统一重试'}); }
    return;
  }
  const lease = newId(), now = nowIso();
  const claim = await env.DB.prepare("UPDATE rehearsal_speech SET status='running',lease_token=?3,lease_expires_at=?4,updated_at=?5 WHERE id=?1 AND job_id=?2 AND (status='queued' OR (status='running' AND lease_expires_at<?5 AND dispatched_at IS NULL))").bind(row.id,jobId,lease,new Date(Date.now()+120_000).toISOString(),now).run();
  if (!claim.meta.changes) return;
  let dispatched = false, recorded = false, tempKey: string | undefined;
  const started = Date.now();
  const assertActive = async () => {
    const currentJob = await getJob(env,jobId);
    if (!['queued','running'].includes(currentJob.status)) throw invalidState('朗读任务已停止');
    if (!await env.DB.prepare("SELECT 1 FROM rehearsal_speech WHERE id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'").bind(row.id,jobId,lease).first()) throw invalidState('朗读执行权已变化');
    const turn = await currentTurn(env,{projectId:row.project_id,rehearsalId:row.rehearsal_id,sequence:row.sequence,actorId:input.actorId});
    if (input.actorId !== row.created_by || turn.id !== row.turn_id || turn.hash !== row.content_hash) throw invalidState('朗读正文已变化');
    return turn;
  };
  try {
    const config = await loadSpeechConfig(env,row.config_version_id), credentials = config.realtimeAudioTranscription;
    if (config.rehearsalSpeech.model !== row.model || config.rehearsalSpeech.voice !== row.voice) throw invalidState('朗读冻结配置不一致');
    const [apiKey,gatewayToken] = await Promise.all([unseal(credentials.apiKeyEncrypted,env.AUTH_SECRET),unseal(credentials.gatewayTokenEncrypted,env.AUTH_SECRET)]);
    const turn = await assertActive();
    await markAiCallStarted(env,jobId); await assertActive();
    const marked = await env.DB.prepare("UPDATE rehearsal_speech SET dispatched_at=?4 WHERE id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'").bind(row.id,jobId,lease,nowIso()).run();
    if (!marked.meta.changes) throw invalidState('朗读执行权已变化');
    dispatched = true;
    const output = await geminiSpeech({accountId:env.CLOUDFLARE_ACCOUNT_ID,gatewayId:credentials.gatewayId,gatewayToken,apiKey,model:row.model,voice:row.voice,text:turn.content});
    // Text pricing cannot price generated audio. Null usage prevents a false zero/known cost.
    await recordAiCall(env,{projectId:row.project_id,jobId,purpose:'review',configVersionId:row.config_version_id,promptVersion:'rehearsal-tts-v1',model:row.model,input:{speechId:row.id,turnId:row.turn_id,contentHash:row.content_hash},output:{mime:output.mime,durationSeconds:output.durationSeconds,bytes:output.bytes.length,providerUsage:output.usage},promptTokens:null,completionTokens:null,latencyMs:Date.now()-started,status:'ok'}); recorded = true;
    await assertActive();
    tempKey = `rehearsal-speech/${row.id}/${jobId}-${lease}.wav`;
    await env.FILES.put(tempKey,output.bytes,{httpMetadata:{contentType:output.mime}});
    await assertActive();
    const saved = await env.DB.prepare(`UPDATE rehearsal_speech SET status='ready',r2_key=?4,mime=?5,duration_seconds=?6,error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?7 WHERE id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'
      AND EXISTS(SELECT 1 FROM jobs WHERE id=?2 AND status IN ('queued','running'))
      AND EXISTS(SELECT 1 FROM rehearsals r JOIN rehearsal_turns t ON t.rehearsal_id=r.id WHERE r.id=rehearsal_speech.rehearsal_id AND r.created_by=rehearsal_speech.created_by AND r.status='active' AND r.finish_job_id IS NULL AND r.processing_job_id IS NULL AND t.id=rehearsal_speech.turn_id AND t.content_json=?8 AND t.sequence=(SELECT MAX(sequence) FROM rehearsal_turns WHERE rehearsal_id=r.id))
      AND EXISTS(SELECT 1 FROM project_members WHERE project_id=rehearsal_speech.project_id AND user_id=rehearsal_speech.created_by)`)
      .bind(row.id,jobId,lease,tempKey,output.mime,output.durationSeconds,nowIso(),turn.contentJson).run();
    if (!saved.meta.changes) throw invalidState('朗读问题或权限已变化，音频未发布');
    tempKey = undefined;
    await settleReservation(env,jobId,'settled'); await succeedJob(env,jobId,{speechId:row.id});
  } catch (error) {
    if (tempKey) await env.FILES.delete(tempKey);
    const safeError = error instanceof AppError ? error : new AppError('AI_UNAVAILABLE','朗读服务请求失败，请重试',503,true);
    if (dispatched && !recorded) await recordAiCall(env,{projectId:row.project_id,jobId,purpose:'review',configVersionId:row.config_version_id,promptVersion:'rehearsal-tts-v1',model:row.model,input:{speechId:row.id,turnId:row.turn_id},output:{code:safeError.code},promptTokens:null,completionTokens:null,latencyMs:Date.now()-started,status:'failed'});
    await env.DB.prepare("UPDATE rehearsal_speech SET status='failed',error=?4,lease_token=NULL,lease_expires_at=NULL,updated_at=?5 WHERE id=?1 AND job_id=?2 AND lease_token=?3 AND status='running'").bind(row.id,jobId,lease,safeError.message,nowIso()).run();
    await settleReservation(env,jobId,'released');
    await failJob(env,jobId,{code:safeError.code,message:safeError.message,details:safeError.details});
  }
}
