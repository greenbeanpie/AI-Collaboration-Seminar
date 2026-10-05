import { describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedUser, seedProject } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { connectTranscribeGateway, parseTranscriptionEvent, parseVoiceClientEvent, transcribeLiveSetup, TRANSCRIBE_LIVE_MODEL } from '../src/ai/gemini-live';
import { assertVoiceSessionActive, cleanupExpiredRehearsalVoiceSessions, closeRehearsalVoiceSession, createRehearsalVoiceSession, openRehearsalVoiceStream, readRehearsalVoice } from '../src/services/rehearsal-voice';

async function fixture() {
  const owner=await seedUser(),projectId=await seedProject(owner.userId),rehearsalId=newId(),now=nowIso();
  const cfg=(await loadAiConfig(env.DB))!;
  cfg.config.processingStrategies={audioFiles:'whisper-first',rehearsal:'voice-with-text-fallback'};
  cfg.config.realtimeAudioTranscription={provider:'google-ai-studio',model:TRANSCRIBE_LIVE_MODEL,gatewayId:'voice-fixture',apiKeyEncrypted:await seal('fixture-google-secret',env.AUTH_SECRET),gatewayTokenEncrypted:await seal('fixture-gateway-secret',env.AUTH_SECRET),languageCodes:['cmn-Hans-CN']};
  await env.DB.prepare('UPDATE ai_config_versions SET enabled=1,config_json=?2 WHERE id=?1').bind(cfg.id,JSON.stringify(cfg.config)).run();
  await env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,material_version_ids_json,created_by,created_at) VALUES(?1,?2,'all','[]',?3,?4)").bind(rehearsalId,projectId,owner.userId,now).run();
  await env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'question','{\"content\":\"已经由文字模型生成的问题\"}',?4)").bind(newId(),rehearsalId,projectId,now).run();
  return {owner,cfg,binding:{projectId,rehearsalId,actorId:owner.userId}};
}
async function row(id:string) { return env.DB.prepare('SELECT * FROM rehearsal_voice_sessions WHERE id=?1').bind(id).first<{status:string;transcript_text:string;retry_number:number;cost_usd:number|null;audio_frames:number}>(); }
const audio={type:'audio',sequence:1,data:btoa('\x01\x00'.repeat(1600))};
async function socketFixture() {
  const f=await fixture(),session=await createRehearsalVoiceSession(env,f.binding,{sequence:1});
  const pair=new WebSocketPair(),provider=pair[1];provider.accept();const messages:unknown[]=[],events:Record<string,unknown>[]=[];
  provider.addEventListener('message',e=>{messages.push(JSON.parse(String(e.data)));});
  const connect=vi.fn(async(_env:unknown,_cfg:unknown,guard:()=>Promise<void>)=>{await guard();return pair[0];});
  const response=await openRehearsalVoiceStream(env,f.binding,session.sessionId,{connect});
  const browser=response.webSocket!;browser.accept();browser.addEventListener('message',e=>{events.push(JSON.parse(String(e.data)));});
  provider.send(JSON.stringify({setupComplete:{}}));await vi.waitFor(()=>expect(events.some(e=>e.type==='ready')).toBe(true));
  return {...f,session,provider,browser,messages,events,connect};
}

describe('private Gemini Transcribe Live rehearsal ASR',()=>{
  it('pins speech-only setup and rejects arbitrary provider fields, malformed audio and oversized frames',()=>{
    const setup=transcribeLiveSetup({provider:'google-ai-studio',model:TRANSCRIBE_LIVE_MODEL,gatewayId:'voice',languageCodes:['cmn-Hans-CN']});
    expect(setup).toMatchObject({setup:{model:'models/gemini-3.5-transcribe-live',generationConfig:{responseModalities:['TEXT']},realtimeInputConfig:{automaticActivityDetection:{disabled:true}},inputAudioTranscription:{mode:'VERBATIM',languageCodes:['cmn-Hans-CN']}}});
    expect(JSON.stringify(setup)).not.toMatch(/systemInstruction|tools|question/);
    expect(parseVoiceClientEvent(JSON.stringify(audio))).toEqual(audio);
    for(const data of [{type:'setup',model:'evil'}, {...audio,tools:[]}, {...audio,data:'????'}, {...audio,data:btoa('x')}, {type:'audio',sequence:1,data:btoa('\x00'.repeat(32770))}])expect(()=>parseVoiceClientEvent(JSON.stringify(data))).toThrow();
    expect(()=>parseVoiceClientEvent(' '.repeat(49153))).toThrow();
    expect(parseTranscriptionEvent(JSON.stringify({serverContent:{interimInputTranscription:{text:'半句'},inputTranscription:{text:'最终'},turnComplete:true}}))).toMatchObject({partial:'半句',final:'最终',complete:true});
    expect(()=>parseTranscriptionEvent(JSON.stringify({error:{message:'private-key'}}))).toThrow('未能完成');
  });
  it('uses only Cloudflare Gateway with server-only credentials and does not follow redirects',async()=>{
    const f=await fixture(),pair=new WebSocketPair();pair[1].accept();
    const fetch=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(null,{status:101,webSocket:pair[0]}));
    const guard=vi.fn(async()=>{});const ws=await connectTranscribeGateway(env,f.cfg.config.realtimeAudioTranscription!,guard,fetch as typeof globalThis.fetch);ws.accept();
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://gateway.ai.cloudflare.com/v1/test-account-id/voice-fixture/google?api_key=fixture-google-secret');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({redirect:'manual',headers:{Upgrade:'websocket','cf-aig-authorization':'Bearer fixture-gateway-secret','cf-aig-collect-log':'false'}});
    expect(guard).toHaveBeenCalledTimes(1);ws.close();pair[1].close();
  });
  it('returns readiness without secrets, rejects finite budgets and restricts recording to the initiator',async()=>{
    const f=await fixture();expect(await readRehearsalVoice(env,f.binding)).toMatchObject({configured:true,ready:true,mode:'voice-with-text-fallback'});
    expect(JSON.stringify(await readRehearsalVoice(env,f.binding))).not.toMatch(/secret|Encrypted|gatewayId/);
    const other=await seedUser();await expect(createRehearsalVoiceSession(env,{...f.binding,actorId:other.userId},{sequence:1})).rejects.toThrow('发起人');
    await env.DB.prepare('UPDATE projects SET ai_budget_usd=10 WHERE id=?1').bind(f.binding.projectId).run();
    expect(await readRehearsalVoice(env,f.binding)).toMatchObject({ready:false});
    await expect(createRehearsalVoiceSession(env,f.binding,{sequence:1})).rejects.toThrow('金额预算');
  });
  it('claims a unique active session and one shared project concurrency slot atomically',async()=>{
    const f=await fixture();const results=await Promise.allSettled([createRehearsalVoiceSession(env,f.binding,{sequence:1}),createRehearsalVoiceSession(env,f.binding,{sequence:1})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const session=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{sessionId:string}>).value;
    const reservation=await env.DB.prepare("SELECT status,settled_cost FROM usage_reservations WHERE job_id=?1").bind(session.sessionId).first<{status:string;settled_cost:number|null}>();
    expect(reservation).toEqual({status:'reserved',settled_cost:null});
    await closeRehearsalVoiceSession(env,f.binding,session.sessionId);await closeRehearsalVoiceSession(env,f.binding,session.sessionId);
    expect((await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(session.sessionId).first<{status:string}>())?.status).toBe('released');
  });
  it('guards the current question, membership and ten-minute TTL before connecting',async()=>{
    const f=await fixture(),session=await createRehearsalVoiceSession(env,f.binding,{sequence:1});
    await env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,created_at) VALUES(?1,?2,?3,2,'answer',?4)").bind(newId(),f.binding.rehearsalId,f.binding.projectId,nowIso()).run();
    await expect(assertVoiceSessionActive(env,f.binding,session.sessionId)).rejects.toThrow('轮次');
    await env.DB.prepare("UPDATE rehearsal_voice_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(session.sessionId).run();
    await cleanupExpiredRehearsalVoiceSessions(env);expect((await row(session.sessionId))?.status).toBe('expired');
  });
  it('streams only audio to the provider, persists final captions, and never creates an answer',async()=>{
    const f=await socketFixture();
    await expect(openRehearsalVoiceStream(env,f.binding,f.session.sessionId,{connect:f.connect})).rejects.toThrow('重复升级');
    f.browser.send(JSON.stringify({type:'start'}));f.browser.send(JSON.stringify(audio));f.browser.send(JSON.stringify({type:'stop'}));
    await vi.waitFor(()=>expect(f.messages).toHaveLength(4));
    expect(f.messages[0]).toMatchObject({setup:{model:'models/gemini-3.5-transcribe-live',inputAudioTranscription:{languageCodes:['cmn-Hans-CN']}}});
    expect(f.messages[1]).toEqual({realtimeInput:{activityStart:{}}});expect(f.messages[2]).toMatchObject({realtimeInput:{audio:{mimeType:'audio/pcm;rate=16000'}}});expect(f.messages[3]).toEqual({realtimeInput:{activityEnd:{}}});
    f.provider.send(JSON.stringify({serverContent:{interimInputTranscription:{text:'临时'}}}));
    f.provider.send(JSON.stringify({serverContent:{inputTranscription:{text:'核对后才提交'},turnComplete:true}}));
    await vi.waitFor(async()=>expect((await row(f.session.sessionId))?.status).toBe('succeeded'));
    expect(await row(f.session.sessionId)).toMatchObject({transcript_text:'核对后才提交',cost_usd:null,audio_frames:1});
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM rehearsal_turns WHERE rehearsal_id=?1 AND kind=\'answer\'').bind(f.binding.rehearsalId).first<{n:number}>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT status,settled_cost FROM usage_reservations WHERE job_id=?1').bind(f.session.sessionId).first())).toEqual({status:'pending_reconcile',settled_cost:null});
    expect(f.events).toContainEqual({type:'final',text:'核对后才提交',sequence:2});f.browser.close();
  });
  it('closes on revoked membership and retains unknown cost without sending the next audio chunk',async()=>{
    const f=await socketFixture();f.browser.send(JSON.stringify({type:'start'}));await vi.waitFor(()=>expect(f.messages.length).toBe(2));
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.binding.projectId,f.binding.actorId).run();
    f.browser.send(JSON.stringify(audio));await vi.waitFor(async()=>expect((await row(f.session.sessionId))?.status).toBe('failed'));
    expect(f.messages).toHaveLength(2);expect(f.events.some(e=>e.type==='error'&&e.retryAfterSeconds===60)).toBe(true);f.browser.close();
  });
});
