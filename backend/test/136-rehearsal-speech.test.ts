import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { createApp } from '../src/app';
import { reserveAiSlot, markAiCallStarted } from '../src/services/ai-reservations';
import { recordAiCall } from '../src/ai/calls';
import { geminiSpeech, inspectSpeechWav } from '../src/ai/gemini-tts';
import { enqueueRehearsalSpeech, readRehearsalSpeechAudio, runRehearsalSpeechJob, retireCloudRehearsalSpeechJobs, readRehearsalSpeech } from '../src/services/rehearsal-speech';

afterEach(() => vi.unstubAllGlobals());
function wav() {
  const b = new Uint8Array(2044), v = new DataView(b.buffer), text = (offset: number, s: string) => { b.set(new TextEncoder().encode(s),offset); };
  text(0,'RIFF'); v.setUint32(4,b.length-8,true); text(8,'WAVE'); text(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,24000,true); v.setUint32(28,48000,true); v.setUint16(32,2,true); v.setUint16(34,16,true); text(36,'data'); v.setUint32(40,2000,true); return b;
}
function result() { return {status:'completed',steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/wav',data:btoa(String.fromCharCode(...wav()))}]}],usage:{total_tokens:42}}; }
const input = {accountId:'account',gatewayId:'speech',gatewayToken:'gateway-secret',model:'gemini-3.8-flash-lite-tts' as const,voice:'Kore' as const,text:'请解释项目目标。'};
async function fixture() {
  const owner=await seedUser(), projectId=await seedProject(owner.userId), rehearsalId=newId(), turnId=newId(), config=(await loadAiConfig(env.DB))!, now=nowIso();
  const raw={...config.config,realtimeAudioTranscription:{provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'speech',gatewayTokenEncrypted:await seal('gateway-secret',env.AUTH_SECRET)},rehearsalSpeech:{model:input.model,voice:'Kore'},processingStrategies:{audioFiles:'whisper-first',rehearsal:'voice-with-text-fallback'}};
  await env.DB.batch([
    env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(config.id,JSON.stringify(raw)),
    env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,created_by,created_at) VALUES(?1,?2,'all',?3,?4)").bind(rehearsalId,projectId,owner.userId,now),
    env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'question',?4,?5)").bind(turnId,rehearsalId,projectId,JSON.stringify({content:input.text,references:[{secret:'must-not-send'}]}),now),
  ]);
  const local={...env,AGENT_WORKFLOW:{create:vi.fn(async()=>({}))}} as unknown as typeof env;
  return {owner,projectId,rehearsalId,turnId,local,params:{projectId,rehearsalId,sequence:1,actorId:owner.userId}};
}
async function openAsr(f: Awaited<ReturnType<typeof fixture>>) {
  const id=newId(),config=(await loadAiConfig(env.DB))!,now=nowIso();
  await env.DB.prepare("INSERT INTO rehearsal_voice_sessions(id,project_id,rehearsal_id,question_sequence,actor_id,config_version_id,model,status,root_session_id,expires_at,created_at,updated_at) VALUES(?1,?2,?3,1,?4,?5,'gemini-3.5-transcribe-live','reserved',?1,?6,?7,?7)").bind(id,f.projectId,f.rehearsalId,f.owner.userId,config.id,new Date(Date.now()+600_000).toISOString(),now).run();
}
describe('Gateway-only TTS transport',()=>{
  it('sends exactly saved text and the fixed REST audio contract',async()=>{
    const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe('https://gateway.ai.cloudflare.com/v1/account/speech/google-ai-studio/v1beta/interactions'); expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('cf-aig-authorization')).toBe('Bearer gateway-secret');
      expect(new Headers(init?.headers).has('x-goog-api-key')).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({model:input.model,input:[{type:'user_input',content:[{type:'text',text:input.text}]}],response_format:{type:'audio',mime_type:'audio/wav'},generation_config:{speech_config:[{voice:'Kore'}]}});
      return Response.json(result());
    });
    expect((await geminiSpeech(input,request)).mime).toBe('audio/wav'); expect(request).toHaveBeenCalledOnce();
  });
  it('rejects empty WAV, incomplete output and direct redirect without retries',async()=>{
    expect(()=>inspectSpeechWav(new Uint8Array(44))).toThrow();
    await expect(geminiSpeech(input,async()=>Response.json({...result(),status:'in_progress'}))).rejects.toMatchObject({code:'AI_OUTPUT_INVALID'});
    const request=vi.fn(async()=>new Response(null,{status:307,headers:{location:'https://generativelanguage.googleapis.com'}}));
    await expect(geminiSpeech(input,request)).rejects.toMatchObject({details:{status:307}}); expect(request).toHaveBeenCalledOnce();
  });
  it('rejects invalid JSON, unsupported MIME, oversized advertised response and truncated RIFF',async()=>{
    await expect(geminiSpeech(input,async()=>new Response('invalid'))).rejects.toMatchObject({code:'AI_OUTPUT_INVALID'});
    const bad=result(); bad.steps[0]!.content[0]!.mime_type='audio/pcm';
    await expect(geminiSpeech(input,async()=>Response.json(bad))).rejects.toMatchObject({code:'AI_OUTPUT_INVALID'});
    await expect(geminiSpeech(input,async()=>new Response('{}',{headers:{'content-length':String(21*1024*1024)}}))).rejects.toThrow('大小限制');
    expect(()=>inspectSpeechWav(wav().subarray(0,100))).toThrow();
  });
});

async function historical(f:Awaited<ReturnType<typeof fixture>>,status:'queued'|'running'|'ready'='queued'){
 const jobId=newId(),speechId=newId(),now=nowIso(),config=(await loadAiConfig(env.DB))!;
 await env.DB.batch([
 env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run',?3,?4,?5,?6,?6)").bind(jobId,f.projectId,status==='ready'?'succeeded':status,JSON.stringify({operation:'rehearsal.tts',speechId,rehearsalId:f.rehearsalId,actorId:f.owner.userId}),f.owner.userId,now),
 env.DB.prepare("INSERT INTO rehearsal_speech(id,project_id,rehearsal_id,turn_id,sequence,created_by,content_hash,config_version_id,model,voice,job_id,status,r2_key,mime,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,'saved-hash',?6,?7,'Kore',?8,?9,?10,'audio/wav',?11,?11)").bind(speechId,f.projectId,f.rehearsalId,f.turnId,f.owner.userId,config.id,input.model,jobId,status,status==='ready'?'history/'+speechId:null,now),
 env.DB.prepare("INSERT INTO job_outbox(id,job_id,status,available_at,created_at,updated_at) VALUES(?1,?2,'pending',?3,?3,?3)").bind(newId(),jobId,now),
 ]);
 if(status==='ready')await env.FILES.put('history/'+speechId,wav());
 else await reserveAiSlot(f.local,{projectId:f.projectId,jobId,purpose:'rehearsal_speech',configVersionId:config.id,maxCalls:2});
 return {jobId,speechId,configId:config.id};
}
describe('retired cloud speech and preserved historical artifacts',()=>{
 it('rejects direct enqueue and authenticated POST with 410 before any reserve or provider request',async()=>{
  const f=await fixture(),request=vi.fn();vi.stubGlobal('fetch',request);
  await expect(enqueueRehearsalSpeech(f.local,f.params)).rejects.toMatchObject({status:410,code:'INVALID_STATE'});
  const res=await createApp().fetch(new Request('https://example.com/api/v1/projects/'+f.projectId+'/rehearsals/'+f.rehearsalId+'/turns/1/speech',{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json'},body:'{}'}),f.local);
  expect(res.status).toBe(410);expect(request).not.toHaveBeenCalled();expect((await env.DB.prepare('SELECT COUNT(*) n FROM usage_reservations WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(0);
 });
 it('voice readiness returns normalized system-local speech even for a frozen cloud configuration',async()=>{
  const f=await fixture(),response=await createApp().fetch(new Request('https://example.com/api/v1/projects/'+f.projectId+'/rehearsals/'+f.rehearsalId+'/voice',{headers:{cookie:authCookie(f.owner.token)}}),f.local);expect(response.status).toBe(200);expect((await response.json() as {data:{speech:unknown}}).data.speech).toEqual({provider:'system-local',lang:'zh-CN',rate:1,volume:1});
 });
 it('cancels queued and running jobs without fetching, closes outbox and protects against late publication',async()=>{
  const request=vi.fn();vi.stubGlobal('fetch',request);
  for(const status of ['queued','running'] as const){const f=await fixture(),old=await historical(f,status);await runRehearsalSpeechJob(f.local,old.jobId);await runRehearsalSpeechJob(f.local,old.jobId);
   expect(await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(old.jobId).first()).toEqual({status:'cancelled'});
   expect(await env.DB.prepare('SELECT status,lease_token FROM rehearsal_speech WHERE id=?1').bind(old.speechId).first()).toEqual({status:'failed',lease_token:null});
   expect(await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(old.jobId).first()).toEqual({status:'released'});
   expect(await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id=?1').bind(old.jobId).first()).toEqual({status:'failed'});
   expect((await env.DB.prepare("UPDATE rehearsal_speech SET status='ready' WHERE id=?1 AND status='running' AND EXISTS(SELECT 1 FROM jobs WHERE id=?2 AND status IN ('queued','running'))").bind(old.speechId,old.jobId).run()).meta.changes).toBe(0);
  }expect(request).not.toHaveBeenCalled();
 });
 it('retirement closes the reservation for failed or missing call results',async()=>{
  const f=await fixture(),old=await historical(f,'running');await markAiCallStarted(f.local,old.jobId);
  await recordAiCall(f.local,{projectId:f.projectId,jobId:old.jobId,purpose:'review',configVersionId:old.configId,promptVersion:'rehearsal-tts-v1',model:input.model,input:{historical:true},output:{error:'timeout'},promptTokens:null,completionTokens:null,latencyMs:1,status:'timeout'});
  await runRehearsalSpeechJob(f.local,old.jobId);
  expect(await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(old.jobId).first()).toEqual({status:'settled'});
  expect(await env.DB.prepare('SELECT model,prompt_tokens,completion_tokens FROM ai_calls WHERE job_id=?1').bind(old.jobId).first()).toEqual({model:input.model,prompt_tokens:null,completion_tokens:null});
  const second=await historical(await fixture(),'running');await markAiCallStarted(f.local,second.jobId);await runRehearsalSpeechJob(f.local,second.jobId);expect(await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(second.jobId).first()).toEqual({status:'settled'});
 });
 it('keeps ready audio private and readable with score permission revoked, while outsiders and withdrawn members cannot read',async()=>{
  const f=await fixture(),old=await historical(f,'ready'),request=vi.fn();vi.stubGlobal('fetch',request);await runRehearsalSpeechJob(f.local,old.jobId);
  await env.DB.prepare("UPDATE project_members SET role='member',permissions_json='{\"scoreInitiate\":false}' WHERE project_id=?1 AND user_id=?2").bind(f.projectId,f.owner.userId).run();
  const params={...f.params,speechId:old.speechId},audio=await readRehearsalSpeechAudio(f.local,params);expect(audio.headers.get('cache-control')).toBe('private, no-store');expect((await audio.arrayBuffer()).byteLength).toBe(wav().length);expect((await readRehearsalSpeech(f.local,params)).status).toBe('ready');
  await expect(readRehearsalSpeechAudio(f.local,{...params,actorId:(await seedUser()).userId})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();await expect(readRehearsalSpeechAudio(f.local,params)).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(request).not.toHaveBeenCalled();
 });
 it('cron retirement is bounded and cannot alter non-TTS jobs or ready audio',async()=>{
  const f=await fixture(),one=await historical(f),two=await historical(await fixture()),ready=await historical(await fixture(),'ready');await retireCloudRehearsalSpeechJobs(f.local,1);
  const firstTwo=await env.DB.prepare('SELECT status FROM jobs WHERE id IN (?1,?2)').bind(one.jobId,two.jobId).all<{status:string}>();expect(firstTwo.results.filter(r=>r.status==='cancelled')).toHaveLength(1);
  await retireCloudRehearsalSpeechJobs(f.local);expect(await env.DB.prepare('SELECT status,r2_key FROM rehearsal_speech WHERE id=?1').bind(ready.speechId).first()).toEqual({status:'ready',r2_key:'history/'+ready.speechId});
 });
});
