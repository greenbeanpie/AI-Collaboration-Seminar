import { afterEach, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createApp } from '../src/app';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { newId, nowIso } from '../src/core/db';
import { runAiJob } from '../src/services/ai-jobs';
import { retryFailedAiJob } from '../src/services/admin-ai-retries';
import { classifyManagedKey } from '../src/services/gc';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const user=await seedUser(),projectId=await seedProject(user.userId),rehearsalId=newId(),now=nowIso();
  const cfg=(await loadAiConfig(env.DB))!;
  cfg.config.processingStrategies={audioFiles:'whisper-first',rehearsal:'voice-with-text-fallback'};
  cfg.config.realtimeAudioTranscription={provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'test-voice',apiKeyEncrypted:await seal('google-fixture',env.AUTH_SECRET),gatewayTokenEncrypted:await seal('gateway-fixture',env.AUTH_SECRET)};
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(cfg.id,JSON.stringify(cfg.config)).run();
  await env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,created_by,created_at) VALUES(?1,?2,'all',?3,?4)").bind(rehearsalId,projectId,user.userId,now).run();
  await env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'question','{\"content\":\"请说明实施步骤。\"}',?4)").bind(newId(),rehearsalId,projectId,now).run();
  const app=createApp(),prefix=`/api/v1/projects/${projectId}/rehearsals/${rehearsalId}`,headers={cookie:authCookie(user.token),Origin:'http://localhost:5173','content-type':'application/json'};
  return {user,projectId,rehearsalId,app,prefix,headers};
}

it('preserves the WebSocket upgrade through app middleware and persists captions without submitting an answer',async()=>{
  const f=await fixture(),ctx=createExecutionContext();
  const response=await f.app.fetch(new Request(BASE+f.prefix+'/voice-sessions',{method:'POST',headers:f.headers,body:'{"sequence":1}'}),env,ctx);
  expect(response.status).toBe(201);
  const session=(await response.json() as {data:{sessionId:string;webSocketPath:string}}).data;
  const pair=new WebSocketPair(),provider=pair[1];provider.accept();
  const sent:Record<string,unknown>[]=[];provider.addEventListener('message',e=>{sent.push(JSON.parse(String(e.data)));});
  vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL)=>{expect(new URL(String(url)).hostname).toBe('gateway.ai.cloudflare.com');return new Response(null,{status:101,webSocket:pair[0]});}));
  const upgrade=await f.app.fetch(new Request(BASE+session.webSocketPath,{headers:{...f.headers,Upgrade:'websocket'}}),env,ctx);
  expect(upgrade.status).toBe(101);expect(upgrade.headers.get('X-Request-Id')).toBeTruthy();
  const browser=upgrade.webSocket!;browser.accept();const events:Record<string,unknown>[]=[];
  browser.addEventListener('message',e=>{events.push(JSON.parse(String(e.data)));});
  provider.send('{"setupComplete":{}}');await vi.waitFor(()=>expect(events.some(e=>e.type==='ready')).toBe(true));
  browser.send('{"type":"start"}');browser.send('{"type":"stop"}');
  await vi.waitFor(()=>expect(sent.some(e=>JSON.stringify(e).includes('activityEnd'))).toBe(true));
  provider.send('{"serverContent":{"inputTranscription":{"text":"最终回答文字"},"turnComplete":true}}');
  await vi.waitFor(()=>expect(events.some(e=>e.type==='complete')).toBe(true));
  await waitOnExecutionContext(ctx);
  expect(await env.DB.prepare('SELECT transcript_text,status FROM rehearsal_voice_sessions WHERE id=?1').bind(session.sessionId).first()).toEqual({transcript_text:'最终回答文字',status:'succeeded'});
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM rehearsal_turns WHERE rehearsal_id=?1 AND kind='answer'").bind(f.rehearsalId).first<{n:number}>())!.n).toBe(0);
});

it('routes TTS jobs through the common dispatcher and replaces failed speech jobs without touching text processing',async()=>{
  const f=await fixture(),local={...env,AGENT_WORKFLOW:{create:vi.fn(async()=>({}))}} as unknown as typeof env;
  const response=await f.app.fetch(new Request(BASE+f.prefix+'/turns/1/speech',{method:'POST',headers:f.headers,body:'{}'}),local);
  expect(response.status).toBe(202);const queued=(await response.json() as {data:{jobId:string;speechId:string}}).data;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:503})));
  await runAiJob(local,queued.jobId);
  const next=await retryFailedAiJob(local,queued.jobId,undefined,`job:${queued.jobId}`);
  expect(next.status).toBe('queued');expect(next.jobId).not.toBe(queued.jobId);
  expect(await env.DB.prepare('SELECT status,job_id FROM rehearsal_speech WHERE id=?1').bind(queued.speechId).first()).toEqual({status:'queued',job_id:next.jobId});
  expect(await env.DB.prepare('SELECT processing_job_id FROM rehearsals WHERE id=?1').bind(f.rehearsalId).first()).toEqual({processing_job_id:null});
  expect(classifyManagedKey(`rehearsal-speech/${queued.speechId}/${next.jobId}-${newId()}.wav`)).toEqual({kind:'rehearsal_speech',id:queued.speechId});
});
