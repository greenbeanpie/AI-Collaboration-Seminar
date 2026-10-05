import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { geminiSpeech, inspectSpeechWav } from '../src/ai/gemini-tts';
import { enqueueRehearsalSpeech, readRehearsalSpeechAudio, runRehearsalSpeechJob } from '../src/services/rehearsal-speech';

afterEach(() => vi.unstubAllGlobals());
function wav() {
  const b = new Uint8Array(2044), v = new DataView(b.buffer), text = (offset: number, s: string) => { b.set(new TextEncoder().encode(s),offset); };
  text(0,'RIFF'); v.setUint32(4,b.length-8,true); text(8,'WAVE'); text(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,24000,true); v.setUint32(28,48000,true); v.setUint16(32,2,true); v.setUint16(34,16,true); text(36,'data'); v.setUint32(40,2000,true); return b;
}
function result() { return {status:'completed',steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/wav',data:btoa(String.fromCharCode(...wav()))}]}],usage:{total_tokens:42}}; }
const input = {accountId:'account',gatewayId:'speech',gatewayToken:'gateway-secret',apiKey:'google-secret',model:'gemini-3.8-flash-lite-tts' as const,voice:'Kore' as const,text:'请解释项目目标。'};
async function fixture() {
  const owner=await seedUser(), projectId=await seedProject(owner.userId), rehearsalId=newId(), turnId=newId(), config=(await loadAiConfig(env.DB))!, now=nowIso();
  const raw={...config.config,realtimeAudioTranscription:{provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'speech',apiKeyEncrypted:await seal('google-secret',env.AUTH_SECRET),gatewayTokenEncrypted:await seal('gateway-secret',env.AUTH_SECRET)},rehearsalSpeech:{model:input.model,voice:'Kore'},processingStrategies:{audioFiles:'whisper-first',rehearsal:'voice-with-text-fallback'}};
  await env.DB.batch([
    env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(config.id,JSON.stringify(raw)),
    env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,created_by,created_at) VALUES(?1,?2,'all',?3,?4)").bind(rehearsalId,projectId,owner.userId,now),
    env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'question',?4,?5)").bind(turnId,rehearsalId,projectId,JSON.stringify({content:input.text,references:[{secret:'must-not-send'}]}),now),
  ]);
  const local={...env,AGENT_WORKFLOW:{create:vi.fn(async()=>({}))}} as unknown as typeof env;
  return {owner,projectId,rehearsalId,turnId,local,params:{projectId,rehearsalId,sequence:1,actorId:owner.userId}};
}
describe('Gateway-only TTS transport',()=>{
  it('sends exactly saved text and the fixed REST audio contract',async()=>{
    const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe('https://gateway.ai.cloudflare.com/v1/account/speech/google-ai-studio/v1beta/interactions'); expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('cf-aig-authorization')).toBe('Bearer gateway-secret');
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
describe('saved rehearsal speech',()=>{
  it('publishes private cached audio once with unknown cost and leaves text turn untouched',async()=>{
    const f=await fixture(), queued=await enqueueRehearsalSpeech(f.local,f.params);
    const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{expect(String(init?.body)).not.toContain('must-not-send');return Response.json(result());}); vi.stubGlobal('fetch',request);
    await runRehearsalSpeechJob(f.local,queued.jobId); await runRehearsalSpeechJob(f.local,queued.jobId);
    const cached=await enqueueRehearsalSpeech(f.local,f.params); expect(cached).toEqual({...queued,status:'ready'}); expect(request).toHaveBeenCalledOnce();
    const audio=await readRehearsalSpeechAudio(f.local,{...f.params,speechId:queued.speechId}); expect(audio.headers.get('cache-control')).toBe('private, no-store'); expect((await audio.arrayBuffer()).byteLength).toBe(wav().length);
    expect(await env.DB.prepare('SELECT model,cost_status,cost_usd FROM ai_calls WHERE job_id=?1').bind(queued.jobId).first()).toEqual({model:input.model,cost_status:'unknown',cost_usd:null});
    expect(await env.DB.prepare('SELECT status,settled_cost FROM usage_reservations WHERE job_id=?1').bind(queued.jobId).first()).toEqual({status:'pending_reconcile',settled_cost:null});
    expect(await env.DB.prepare('SELECT processing_job_id FROM rehearsals WHERE id=?1').bind(f.rehearsalId).first()).toEqual({processing_job_id:null});
  });
  it('rejects finite budget and outsiders before dispatch',async()=>{
    const f=await fixture(), other=await seedUser();
    await expect(enqueueRehearsalSpeech(f.local,{...f.params,actorId:other.userId})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await env.DB.prepare('UPDATE projects SET ai_budget_usd=10 WHERE id=?1').bind(f.projectId).run();
    await expect(enqueueRehearsalSpeech(f.local,f.params)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
  });
  it('cancellation, changed sequence and withdrawn membership prevent a request',async()=>{
    for(const mode of ['cancel','sequence','membership']) {
      const f=await fixture(), queued=await enqueueRehearsalSpeech(f.local,f.params), request=vi.fn(async()=>Response.json(result()));vi.stubGlobal('fetch',request);
      if(mode==='cancel')await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id=?1").bind(queued.jobId).run();
      if(mode==='membership')await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();
      if(mode==='sequence')await env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,2,'answer','{\"content\":\"回答\"}',?4)").bind(newId(),f.rehearsalId,f.projectId,nowIso()).run();
      await runRehearsalSpeechJob(f.local,queued.jobId); expect(request).not.toHaveBeenCalled();
    }
  });
  it('concurrent workers hold one lease and revoked membership blocks late publication',async()=>{
    const f=await fixture(), queued=await enqueueRehearsalSpeech(f.local,f.params);
    let release!:()=>void; const waiting=new Promise<void>(resolve=>{release=resolve;}); let entered!:()=>void; const enteredRequest=new Promise<void>(resolve=>{entered=resolve;});
    const request=vi.fn(async()=>{entered();await waiting;return Response.json(result());});vi.stubGlobal('fetch',request);
    const first=runRehearsalSpeechJob(f.local,queued.jobId); await enteredRequest; await runRehearsalSpeechJob(f.local,queued.jobId);
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();release();await first;
    expect(request).toHaveBeenCalledOnce();expect(await env.DB.prepare('SELECT status,r2_key FROM rehearsal_speech WHERE id=?1').bind(queued.speechId).first()).toEqual({status:'failed',r2_key:null});
  });
});
