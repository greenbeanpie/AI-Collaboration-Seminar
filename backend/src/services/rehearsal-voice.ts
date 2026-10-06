import { DEFAULT_REHEARSAL_SPEECH, type RehearsalSpeechConfig } from '../../../shared/audio-settings';
import type { Env } from '../env';
import { loadAiConfig } from '../ai/config';
import { connectTranscribeGateway, TRANSCRIBE_LIVE_MODEL, parseTranscriptionEvent, parseVoiceClientEvent, transcribeLiveSetup, upstreamAudioEvent, type RealtimeTranscriptionConfig, type VoiceServerEvent } from '../ai/gemini-live';
import { AppError, aiUnavailable, invalidState, notFound, permissionDenied, quotaExceeded } from '../core/errors';
import { newId, nowIso } from '../core/db';
import { projectPermissionSql } from './project-permissions';

export const REHEARSAL_VOICE_TTL_MS=600_000;
interface VoiceConfig {realtimeAudioTranscription?:RealtimeTranscriptionConfig;processingStrategies?:{rehearsal?:'text'|'voice-with-text-fallback'};rehearsalSpeech?:RehearsalSpeechConfig}
export interface VoiceBinding {projectId:string;rehearsalId:string;actorId:string}
export interface VoiceSession extends VoiceBinding {id:string;question_sequence:number;config_version_id:string;status:string;expires_at:string;transcript_text:string;root_session_id:string;retry_number:number;started_at:string|null;finished_at:string|null}
function activeGuard(rehearsal:string,project:string,actor:string,sequence:string):string {
  return `EXISTS(SELECT 1 FROM rehearsals r JOIN projects p ON p.id=r.project_id WHERE r.id=${rehearsal} AND r.project_id=${project} AND r.created_by=${actor} AND r.status='active' AND p.status='active'
    AND ${projectPermissionSql(project,actor,'scoreInitiate')}
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=r.processing_job_id AND j.status IN ('queued','running','waiting_input'))
    AND EXISTS(SELECT 1 FROM rehearsal_turns t WHERE t.rehearsal_id=r.id AND t.sequence=${sequence} AND t.kind IN ('question','followup'))
    AND ${sequence}=(SELECT MAX(t.sequence) FROM rehearsal_turns t WHERE t.rehearsal_id=r.id))`;
}
async function ownedRehearsal(env:Env,binding:VoiceBinding) {
  const row=await env.DB.prepare('SELECT r.created_by,r.status FROM rehearsals r JOIN projects p ON p.id=r.project_id WHERE r.id=?1 AND r.project_id=?2').bind(binding.rehearsalId,binding.projectId).first<{created_by:string;status:string}>();
  if(!row)throw notFound('答辩演练不存在');
  return row;
}
export async function readRehearsalVoice(env:Env,binding:VoiceBinding) {
  const rehearsal=await ownedRehearsal(env,binding);
  const cfg=await loadAiConfig(env.DB),voice=cfg?.config as VoiceConfig|undefined,slot=voice?.realtimeAudioTranscription;
  const configured=Boolean(cfg?.enabled && slot?.provider==='google-ai-studio' && slot.model===TRANSCRIBE_LIVE_MODEL && /^[a-z0-9-]{1,64}$/.test(slot.gatewayId) && slot.gatewayTokenEncrypted);
  const mode=voice?.processingStrategies?.rehearsal??'text';
  let reason:string|null=null;
  if(mode==='text')reason='本项目使用文字答辩模式';
  else if(!configured || !/^[a-zA-Z0-9_-]+$/.test(env.CLOUDFLARE_ACCOUNT_ID))reason='实时转录Gateway配置不完整；可继续文字回答';
  else if(rehearsal.created_by!==binding.actorId)reason='只有本轮发起人可以录音';
  else {
    const valid=await env.DB.prepare(`SELECT 1 WHERE ${activeGuard('?1','?2','?3',"(SELECT MAX(sequence) FROM rehearsal_turns WHERE rehearsal_id=?1)")}`).bind(binding.rehearsalId,binding.projectId,binding.actorId).first();
    if(!valid)reason='当前轮次不可录音，请等待评委问题或使用文字回答';
  }
  return {configured,ready:reason===null,mode,reason,speech:voice?.rehearsalSpeech??DEFAULT_REHEARSAL_SPEECH};
}
export async function createRehearsalVoiceSession(env:Env,binding:VoiceBinding,input:{sequence:number;retryOfSessionId?:string}) {
  const rehearsal=await ownedRehearsal(env,binding);
  if(rehearsal.created_by!==binding.actorId)throw permissionDenied('只有本轮发起人可以录音');
  const readiness=await readRehearsalVoice(env,binding);
  if(!readiness.ready)throw aiUnavailable(readiness.reason??'语音未准备好');
  const cfg=(await loadAiConfig(env.DB))!,id=newId(),now=nowIso(),expiresAt=new Date(Date.now()+REHEARSAL_VOICE_TTL_MS).toISOString();
  let root=id,retry=0;
  if(input.retryOfSessionId) {
    const previous=await env.DB.prepare("SELECT * FROM rehearsal_voice_sessions WHERE id=?1 AND project_id=?2 AND rehearsal_id=?3 AND actor_id=?4 AND question_sequence=?5 AND status='failed'").bind(input.retryOfSessionId,binding.projectId,binding.rehearsalId,binding.actorId,input.sequence).first<VoiceSession>();
    if(!previous || !previous.finished_at || previous.config_version_id!==cfg.id)throw invalidState('原语音请求不能自动重建或模型配置已变化');
    if(Date.now()-Date.parse(previous.finished_at)<60_000)throw new AppError('RATE_LIMITED','请在一分钟后重新连接',429,true,{retryAfterSeconds:60});
    if(previous.retry_number>=3)throw invalidState('语音已连续重试三次，请主动重新开始或使用文字回答');
    root=previous.root_session_id;retry=previous.retry_number+1;
  }
  const slotId=newId();
  await cleanupExpiredRehearsalVoiceSessions(env);
  const writes=await env.DB.batch([
    env.DB.prepare(`INSERT INTO rehearsal_voice_sessions(id,project_id,rehearsal_id,question_sequence,actor_id,config_version_id,model,status,root_session_id,retry_number,expires_at,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,'reserved',?8,?9,?10,?11,?11
      WHERE ${activeGuard('?3','?2','?5','?4')}
      AND EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?6 AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions) AND json_extract(config_json,'$.processingStrategies.rehearsal')='voice-with-text-fallback')
      AND NOT EXISTS(SELECT 1 FROM rehearsal_voice_sessions WHERE rehearsal_id=?3 AND status IN ('reserved','connecting','open'))
      AND NOT EXISTS(SELECT 1 FROM jobs WHERE project_id=?2 AND status IN ('queued','running','waiting_input') AND json_extract(input_json,'$.operation')='rehearsal.tts' AND json_extract(input_json,'$.rehearsalId')=?3)
      AND NOT EXISTS(SELECT 1 FROM rehearsal_speech sp LEFT JOIN jobs j ON j.id=sp.job_id WHERE sp.rehearsal_id=?3 AND sp.status IN ('queued','running') AND (j.id IS NULL OR j.status IN ('queued','running','waiting_input')))
      AND (SELECT COUNT(*) FROM usage_reservations WHERE project_id=?2 AND status='reserved')<2
      AND (?9=0 OR ?9=(SELECT MAX(retry_number)+1 FROM rehearsal_voice_sessions WHERE root_session_id=?8))`).bind(id,binding.projectId,binding.rehearsalId,input.sequence,binding.actorId,cfg.id,TRANSCRIBE_LIVE_MODEL,root,retry,expiresAt,now),
    env.DB.prepare("INSERT INTO usage_reservations(id,project_id,job_id,purpose,status,max_calls,created_at) SELECT ?1,?2,?3,'rehearsal_voice','reserved',1,?4 WHERE EXISTS(SELECT 1 FROM rehearsal_voice_sessions WHERE id=?3 AND status='reserved')").bind(slotId,binding.projectId,id,now),
  ]);
  if(!writes[0]?.meta.changes)throw invalidState('录音已占用、并发额度不足或问题轮次已变化');
  return {sessionId:id,webSocketPath:`/api/v1/projects/${binding.projectId}/rehearsals/${binding.rehearsalId}/voice-sessions/${id}/stream`,expiresAt};
}
async function getVoiceSession(env:Env,binding:VoiceBinding,sessionId:string):Promise<VoiceSession> {
  const row=await env.DB.prepare('SELECT * FROM rehearsal_voice_sessions WHERE id=?1 AND project_id=?2 AND rehearsal_id=?3 AND actor_id=?4').bind(sessionId,binding.projectId,binding.rehearsalId,binding.actorId).first<VoiceSession>();
  if(!row)throw notFound('语音请求不存在');
  return row;
}
export async function assertVoiceSessionActive(env:Env,binding:VoiceBinding,sessionId:string):Promise<VoiceSession> {
  const row=await getVoiceSession(env,binding,sessionId),cfg=await loadAiConfig(env.DB);
  if(!['reserved','connecting','open'].includes(row.status) || Date.parse(row.expires_at)<=Date.now())throw invalidState('语音请求已结束或过期');
  if(!cfg?.enabled || cfg.id!==row.config_version_id || (cfg.config as VoiceConfig).processingStrategies?.rehearsal!=='voice-with-text-fallback')throw invalidState('语音配置已变化');
  const allowed=await env.DB.prepare(`SELECT 1 WHERE ${activeGuard('?1','?2','?3','?4')}`).bind(binding.rehearsalId,binding.projectId,binding.actorId,row.question_sequence).first();
  if(!allowed)throw permissionDenied('录音权限或答辩轮次已变化');
  return row;
}
export async function finishRehearsalVoiceSession(env:Env,sessionId:string,status:'succeeded'|'failed'|'closed'|'expired',errorCode?:string):Promise<void> {
  const now=nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE rehearsal_voice_sessions SET status=?2,error_code=?3,finished_at=?4,updated_at=?4,duration_seconds=CASE WHEN started_at IS NOT NULL THEN MAX(0,(julianday(?4)-julianday(started_at))*86400) ELSE NULL END WHERE id=?1 AND status IN ('reserved','connecting','open')").bind(sessionId,status,errorCode??null,now),
    env.DB.prepare("UPDATE usage_reservations SET status=CASE WHEN (SELECT started_at FROM rehearsal_voice_sessions WHERE id=?1) IS NULL THEN 'released' ELSE 'settled' END,settled_at=?2 WHERE job_id=?1 AND purpose='rehearsal_voice' AND status='reserved' AND EXISTS(SELECT 1 FROM rehearsal_voice_sessions WHERE id=?1 AND status IN ('succeeded','failed','closed','expired'))").bind(sessionId,now),
  ]);
}
export async function closeRehearsalVoiceSession(env:Env,binding:VoiceBinding,sessionId:string) {
  await getVoiceSession(env,binding,sessionId);
  await finishRehearsalVoiceSession(env,sessionId,'closed');
  return {sessionId,status:'closed' as const};
}
export async function cleanupExpiredRehearsalVoiceSessions(env:Env):Promise<void> {
  const rows=await env.DB.prepare("SELECT id FROM rehearsal_voice_sessions WHERE status IN ('reserved','connecting','open') AND expires_at<=?1 LIMIT 50").bind(nowIso()).all<{id:string}>();
  for(const row of rows.results)await finishRehearsalVoiceSession(env,row.id,'expired');
}

interface SocketOptions {connect?:typeof connectTranscribeGateway;authenticate?:()=>Promise<void>;waitUntil?:(promise:Promise<unknown>)=>void}
/** Bridges a bounded push-to-talk protocol; never forwards project context or submits answers. */
export async function openRehearsalVoiceStream(env:Env,binding:VoiceBinding,sessionId:string,options:SocketOptions={}):Promise<Response> {
  const row=await assertVoiceSessionActive(env,binding,sessionId);
  const claim=await env.DB.prepare("UPDATE rehearsal_voice_sessions SET status='connecting',updated_at=?2 WHERE id=?1 AND status='reserved' AND expires_at>?2").bind(sessionId,nowIso()).run();
  if(!claim.meta.changes)throw invalidState('语音请求已连接，不能重复升级');
  const guard=async()=>{await options.authenticate?.();await assertVoiceSessionActive(env,binding,sessionId);};
  let upstream:WebSocket,slot:RealtimeTranscriptionConfig;
  try {
    const cfg=(await loadAiConfig(env.DB))!,configuredSlot=(cfg.config as VoiceConfig).realtimeAudioTranscription;
    if(!configuredSlot)throw aiUnavailable('实时转录未配置');
    slot=configuredSlot;
    const beforeHandshake=async()=>{await guard();await env.DB.prepare("UPDATE rehearsal_voice_sessions SET started_at=?2 WHERE id=?1 AND status='connecting'").bind(sessionId,nowIso()).run();};
    // Persist immediately before the outbound handshake so recovery will not replay an uncertain call.
    upstream=await (options.connect??connectTranscribeGateway)(env,slot,beforeHandshake);
    await guard();
  } catch(error) {
    await finishRehearsalVoiceSession(env,sessionId,'failed',error instanceof AppError?error.code:'AI_UNAVAILABLE');
    throw error instanceof AppError?error:aiUnavailable('语音Gateway连接失败');
  }
  const pair=new WebSocketPair(),browser=pair[1];browser.accept();upstream.accept();
  await env.DB.prepare("UPDATE rehearsal_voice_sessions SET status='open',updated_at=?2 WHERE id=?1 AND status='connecting'").bind(sessionId,nowIso()).run();
  let finished=false,ready=false,started=false,stopped=false,audioSequence=0,eventSequence=0,audioBytes=0,queued=0,queuedPcmBytes=0;
  let transcript=row.transcript_text,work=Promise.resolve();
  const send=(event:VoiceServerEvent)=>{if(!finished)browser.send(JSON.stringify(event));};
  const finish=async(status:'succeeded'|'failed'|'closed'|'expired',code?:string)=>{
    if(finished)return;finished=true;clearTimeout(ttlTimer);clearTimeout(setupTimer);clearTimeout(stopTimer);clearInterval(authTimer);
    try{upstream.close(1000,'Voice session ended');}catch{/* Already closed. */}
    try{browser.close(status==='failed'?1011:1000,'Voice session ended');}catch{/* Already closed. */}
    await finishRehearsalVoiceSession(env,sessionId,status,code);
  };
  const fail=async(error:unknown)=>{if(finished)return;const code=error instanceof AppError?error.code:'AI_UNAVAILABLE';send({type:'error',code,message:error instanceof AppError?error.message:'语音转录失败，已保留最终字幕；可继续文字回答',retryAfterSeconds:60});await finish('failed',code);};
  const enqueue=(fn:()=>Promise<void>,pcmBytes=0)=>{
    if(finished)return;
    queuedPcmBytes+=pcmBytes;
    if(++queued>64 || queuedPcmBytes>160_000){options.waitUntil?.(fail(quotaExceeded('语音队列繁忙，请停止录音后重试')));if(!options.waitUntil)void fail(quotaExceeded('语音队列繁忙'));return;}
    work=work.then(async()=>{if(!finished)await fn();}).catch(fail).finally(()=>{queued--;queuedPcmBytes-=pcmBytes;});options.waitUntil?.(work);
  };
  const ttlTimer=setTimeout(()=>enqueue(async()=>{await finish('expired','TIMEOUT');}),Math.max(1,Date.parse(row.expires_at)-Date.now()));
  const setupTimer=setTimeout(()=>enqueue(async()=>{throw aiUnavailable('语音Gateway初始化超时');}),15_000);
  let stopTimer:ReturnType<typeof setTimeout>|undefined;
  const authTimer=setInterval(()=>enqueue(guard),5000);
  browser.addEventListener('message',event=>{
    let parsed:ReturnType<typeof parseVoiceClientEvent>;
    try{parsed=parseVoiceClientEvent(event.data);}catch(error){enqueue(async()=>{throw error;});return;}
    enqueue(async()=>{
    await guard();
    if(!ready)throw invalidState('请等待语音服务准备完成');
    if(parsed.type==='start'){if(started||stopped)throw invalidState('录音已开始或已结束');started=true;}
    else if(parsed.type==='stop'){if(!started||stopped)throw invalidState('录音尚未开始或已停止');stopped=true;stopTimer=setTimeout(()=>enqueue(async()=>{throw aiUnavailable('语音结束后未收到最终结果');}),20_000);}
    else {
      if(!started||stopped||parsed.sequence!==audioSequence+1)throw invalidState('录音片段顺序无效或回合已停止');
      audioSequence=parsed.sequence;audioBytes+=atob(parsed.data).length;
      if(audioBytes>32_000*600)throw quotaExceeded('本次录音超过十分钟音频量');
      const buffer=(upstream as WebSocket&{bufferedAmount?:number}).bufferedAmount??0;
      if(buffer>256*1024)throw quotaExceeded('语音传输拥塞，请停止录音后重试');
      await env.DB.prepare("UPDATE rehearsal_voice_sessions SET audio_bytes=?2,audio_frames=?3,updated_at=?4 WHERE id=?1 AND status='open'").bind(sessionId,audioBytes,audioSequence,nowIso()).run();
    }
    upstream.send(JSON.stringify(upstreamAudioEvent(parsed)));
  },parsed.type==='audio'?atob(parsed.data).length:0);
  });
  upstream.addEventListener('message',event=>enqueue(async()=>{
    await guard();const parsed=parseTranscriptionEvent(event.data);
    if(parsed.ready){ready=true;clearTimeout(setupTimer);send({type:'ready'});}
    if(parsed.partial){send({type:'partial',text:parsed.partial,sequence:++eventSequence});}
    if(parsed.final){
      if(transcript.length+parsed.final.length>8000)throw quotaExceeded('转录已达到回答长度上限');
      transcript+=parsed.final;
      await env.DB.prepare("UPDATE rehearsal_voice_sessions SET transcript_text=?2,event_sequence=?3,updated_at=?4 WHERE id=?1 AND status='open'").bind(sessionId,transcript,eventSequence+1,nowIso()).run();
      send({type:'final',text:parsed.final,sequence:++eventSequence});
    }
    if(parsed.complete){send({type:'complete'});await finish('succeeded');}
  }));
  browser.addEventListener('close',()=>enqueue(async()=>{await finish('closed');}));
  browser.addEventListener('error',()=>enqueue(async()=>{throw aiUnavailable('浏览器语音连接中断');}));
  upstream.addEventListener('close',()=>enqueue(async()=>{if(!finished)throw aiUnavailable('语音Gateway连接中断，已保留最终字幕');}));
  upstream.addEventListener('error',()=>enqueue(async()=>{throw aiUnavailable('语音Gateway连接失败，已保留最终字幕');}));
  upstream.send(JSON.stringify(transcribeLiveSetup(slot)));
  // Send the frozen transcription slot, never the general AI configuration or project context.
  return new Response(null,{status:101,webSocket:pair[0]});
}
