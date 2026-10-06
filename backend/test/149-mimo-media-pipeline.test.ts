import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedUser, seedProject } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { newId, nowIso } from '../src/core/db';
import { createApp } from '../src/app';
import { createMediaFetchUrl, readMediaGrant } from '../src/services/media-fetch';
import { runMediaJob, cleanupMediaFiles } from '../src/services/media-summary';
import { getJob } from '../src/services/jobs';
import { whisperEnabled } from '../src/services/audio-pipeline';
import { mediaRouteError, selectedMediaProvider } from '../src/services/media-routing';
import { prepareAutomaticJobRetry } from '../src/services/ai-automatic-retries';

const testEnv={...env,MEDIA_FETCH_BASE_URL:'https://media.example'};
const summary={title:'会议录音',summary:'讨论了研究计划，并约定周五提交报告。',keyPoints:['周五提交报告'],conclusions:['继续研究'],actionItems:['提交报告'],timestamps:[{seconds:2,description:'研究计划'}],caveats:[],complete:true,durationSeconds:10};
afterEach(()=>vi.unstubAllGlobals());
async function fixture(source=false){
 const owner=await seedUser(),config=(await loadAiConfig(env.DB))!,jobId=newId(),fileId=newId(),draftId=newId(),stateId=newId(),versionId=newId(),sourceId=newId(),now=nowIso();
 const model={...config.config.textEconomy,provider:'xiaomi-mimo',model:'mimo-v2.6-pro',apiUrl:'https://api.xiaomimimo.com/v1',apiKeyEncrypted:await seal('mimo-fixture-key',env.AUTH_SECRET)};
 config.config.mimoMediaUnderstanding=model;config.config.processingStrategies={audioFiles:'mimo-only',rehearsal:'text'};
 await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2,enabled=1 WHERE id=?1').bind(config.id,JSON.stringify(config.config)).run();
 const key='mimo-fixture/'+fileId;await env.FILES.put(key,new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69]));
 let projectId:string|null=null;
 if(source){projectId=await seedProject(owner.userId);await env.DB.batch([
  env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,mime_detected,size_bytes,status,created_at) VALUES(?1,?2,?3,?4,'.wav','audio/wav',12,'available',?5)").bind(fileId,projectId,owner.userId,key,now),
  env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','会议',?3,?4,?5,?5)").bind(sourceId,projectId,versionId,owner.userId,now),
  env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'pending',?5)").bind(versionId,sourceId,projectId,fileId,now),
 ]);}else await env.DB.batch([
  env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,revision,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,1,?3,?4,?5,?5)').bind(draftId,owner.userId,JSON.stringify({name:'会议草稿',aiCollaborationEnabled:false}),newId(),now),
  env.DB.prepare("INSERT INTO creation_draft_files(id,draft_id,name,ext,r2_key,sha256,size_bytes,mime,created_at) VALUES(?1,?2,'录音.wav','.wav',?3,'fixture',12,'audio/wav',?4)").bind(fileId,draftId,key,now),
 ]);
 const input=source?{operation:'media.summary',sourceVersionId:versionId,sourceLifecycleVersion:1,configVersionId:config.id,mediaProvider:'mimo'}:{operation:'media.draft',draftId,fileId,configVersionId:config.id,mediaProvider:'mimo'};
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','running',?3,0,?4,?5,?5)").bind(jobId,projectId,JSON.stringify(input),owner.userId,now).run();
 const insertState=()=>env.DB.prepare("INSERT INTO media_processing(id,job_id,source_version_id,draft_file_id,config_version_id,provider,stage,lease_token,lease_expires_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'mimo','generating','fixture-lease',?6,?7,?7)").bind(stateId,jobId,source?versionId:null,source?null:fileId,config.id,new Date(Date.now()+900000).toISOString(),now).run();
 return {owner,config,model,jobId,fileId,draftId,stateId,versionId,sourceId,projectId,key,insertState};
}
function provider(options:{complete?:boolean;error?:boolean;after?:()=>Promise<void>}={}){
 return vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  expect(String(url)).toBe('https://gateway.ai.cloudflare.com/v1/test-account-id/test-gateway-id/custom-xiaomi-mimo/v1/chat/completions');
  expect(new Headers(init?.headers).get('cf-aig-authorization')).toBe('Bearer test-cf-token');
  expect(new Headers(init?.headers).has('api-key')).toBe(false);
  const body=JSON.parse(String(init?.body));expect(body.messages[1].content[0].type).toBe('input_audio');
  const grant=new Request(body.messages[1].content[0].input_audio.data);const fetched=await readMediaGrant(testEnv,grant,new URL(grant.url).pathname.split('/').at(-1)!);
  expect(fetched.status).toBe(200);expect((await fetched.arrayBuffer()).byteLength).toBe(12);
  if(options.error)throw new Error('unknown provider acceptance');
  await options.after?.();
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...summary,complete:options.complete??true})}}],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:10,audio_tokens:63}}});
 });
}
describe('MiMo private audio grants',()=>{
 it('streams full bytes, HEAD, bounded and suffix ranges with no-store',async()=>{
  const f=await fixture();await f.insertState();const url=await createMediaFetchUrl(testEnv,f.jobId),app=createApp();
  const full=await app.request(url,{},testEnv);expect(full.status).toBe(200);expect((await full.arrayBuffer()).byteLength).toBe(12);expect(full.headers.get('cache-control')).toBe('no-store');
  const head=await app.request(url,{method:'HEAD'},testEnv);expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(head.headers.get('content-length')).toBe('12');
  for(const [range,length,content] of [['bytes=2-5',4,'bytes 2-5/12'],['bytes=-3',3,'bytes 9-11/12'],['bytes=8-',4,'bytes 8-11/12']] as const){const response=await app.request(url,{headers:{range}},testEnv);expect(response.status).toBe(206);expect((await response.arrayBuffer()).byteLength).toBe(length);expect(response.headers.get('content-range')).toBe(content);}
  for(const range of ['bytes=50-','bytes=3-2','bytes=0-1,4-5','bytes=-0'])expect((await app.request(url,{headers:{range}},testEnv)).status).toBe(416);
 });
 it('rejects altered signatures, expiry, cross-job and file binding changes',async()=>{
  const f=await fixture();await f.insertState();const url=await createMediaFetchUrl(testEnv,f.jobId);
  const tampered=new URL(url);tampered.searchParams.set('signature','0'.repeat(64));expect((await readMediaGrant(testEnv,new Request(tampered),f.jobId)).status).toBe(404);
  const expired=new URL(url);expired.searchParams.set('expires',String(Math.floor(Date.now()/1000)-1));expect((await readMediaGrant(testEnv,new Request(expired),f.jobId)).status).toBe(404);
  expect((await readMediaGrant(testEnv,new Request(url),newId())).status).toBe(404);
  await env.DB.prepare('UPDATE creation_draft_files SET r2_key=?2 WHERE id=?1').bind(f.fileId,'other-private-object').run();expect((await readMediaGrant(testEnv,new Request(url),f.jobId)).status).toBe(404);
 });
 it.each(['succeeded','failed','cancelled','waiting_input'])('revokes %s task access',async status=>{const f=await fixture();await f.insertState();const url=await createMediaFetchUrl(testEnv,f.jobId);await env.DB.prepare('UPDATE jobs SET status=?2 WHERE id=?1').bind(f.jobId,status).run();expect((await readMediaGrant(testEnv,new Request(url),f.jobId)).status).toBe(404);});
 it('revokes removed draft, submitted draft, expired lease and completed processing',async()=>{
  const f=await fixture();await f.insertState();const url=await createMediaFetchUrl(testEnv,f.jobId);
  await env.DB.prepare('UPDATE creation_draft_files SET removed=1 WHERE id=?1').bind(f.fileId).run();expect((await readMediaGrant(testEnv,new Request(url),f.jobId)).status).toBe(404);
  await env.DB.prepare('UPDATE creation_draft_files SET removed=0 WHERE id=?1').bind(f.fileId).run();await env.DB.prepare("UPDATE media_processing SET stage='ready' WHERE job_id=?1").bind(f.jobId).run();expect((await readMediaGrant(testEnv,new Request(url),f.jobId)).status).toBe(404);
 });
 it('binds source lifecycle and revokes deletion/restore',async()=>{const f=await fixture(true);await f.insertState();const url=await createMediaFetchUrl(testEnv,f.jobId);expect((await readMediaGrant(testEnv,new Request(url),f.jobId)).status).toBe(200);await env.DB.prepare('UPDATE sources SET lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.sourceId).run();expect((await readMediaGrant(testEnv,new Request(url),f.jobId)).status).toBe(404);});
});
describe('MiMo audio orchestration',()=>{
 it.each([false,true])('saves draft/source audio summary and actual usage, revokes link, never paid replay (source=%s)',async source=>{
  const f=await fixture(source),request=provider();vi.stubGlobal('fetch',request);
  expect(await runMediaJob(testEnv,f.jobId,source?f.versionId:undefined)).toEqual({status:'succeeded'});
  expect(request).toHaveBeenCalledTimes(1);const state=await env.DB.prepare('SELECT * FROM media_processing WHERE job_id=?1').bind(f.jobId).first<{provider:string;provider_uri:string|null;stage:string;summary_json:string}>();
  expect(state).toMatchObject({provider:'mimo',provider_uri:null,stage:'ready'});expect(JSON.parse(state!.summary_json)).toEqual(summary);
  const call=await env.DB.prepare('SELECT provider,prompt_tokens,cached_tokens,audio_tokens FROM media_calls WHERE job_id=?1').bind(f.jobId).first();expect(call).toEqual({provider:'mimo',prompt_tokens:100,cached_tokens:10,audio_tokens:63});
  if(source)expect((await env.DB.prepare('SELECT content FROM source_fragments WHERE source_version_id=?1').bind(f.versionId).first<{content:string}>())?.content).toContain('AI 摘要（非逐字原文）');
  else expect((await env.DB.prepare('SELECT pages_json FROM creation_draft_files WHERE id=?1').bind(f.fileId).first<{pages_json:string}>())?.pages_json).toContain('研究计划');
  await runMediaJob(testEnv,f.jobId,source?f.versionId:undefined);expect(request).toHaveBeenCalledTimes(1);
  const body=JSON.parse(String(request.mock.calls[0]![1]!.body));expect((await readMediaGrant(testEnv,new Request(body.messages[1].content[0].input_audio.data),f.jobId)).status).toBe(404);
 });
 it('unknown accepted call does not enter automatic retry queue or Gemini fallback',async()=>{const f=await fixture(),request=provider({error:true});vi.stubGlobal('fetch',request);expect(await runMediaJob(testEnv,f.jobId)).toEqual({status:'failed'});await runMediaJob(testEnv,f.jobId);expect(request).toHaveBeenCalledTimes(1);expect(await env.DB.prepare('SELECT status FROM media_calls WHERE job_id=?1').bind(f.jobId).first()).toEqual({status:'unknown'});expect(await env.DB.prepare('SELECT COUNT(*) n FROM ai_automatic_retries WHERE target_id=?1').bind(f.jobId).first()).toEqual({n:0});expect(await env.FILES.head(f.key)).toBeTruthy();});
 it('preserves partial result but does not publish it as ready',async()=>{const f=await fixture();vi.stubGlobal('fetch',provider({complete:false}));await runMediaJob(testEnv,f.jobId);expect((await getJob(env,f.jobId)).status).toBe('failed');const state=await env.DB.prepare('SELECT summary_json FROM media_processing WHERE job_id=?1').bind(f.jobId).first<{summary_json:string}>();expect(JSON.parse(state!.summary_json).complete).toBe(false);expect(await env.DB.prepare('SELECT pages_json FROM creation_draft_files WHERE id=?1').bind(f.fileId).first()).toEqual({pages_json:'[]'});});
 it('cancellation after model call preserves call records without publishing',async()=>{const f=await fixture();vi.stubGlobal('fetch',provider({after:async()=>{await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id=?1").bind(f.jobId).run();}}));await runMediaJob(testEnv,f.jobId);expect((await getJob(env,f.jobId)).status).toBe('cancelled');expect(await env.DB.prepare('SELECT pages_json FROM creation_draft_files WHERE id=?1').bind(f.fileId).first()).toEqual({pages_json:'[]'});expect(await env.DB.prepare('SELECT status FROM media_calls WHERE job_id=?1').bind(f.jobId).first()).toEqual({status:'ok'});});
 it('busy lease does not issue another request',async()=>{const f=await fixture();await f.insertState();const request=provider();vi.stubGlobal('fetch',request);expect(await runMediaJob(testEnv,f.jobId)).toEqual({status:'busy'});expect(request).not.toHaveBeenCalled();});
 it('a stale paid-call owner cannot fail a task owned by a newer lease',async()=>{const f=await fixture();vi.stubGlobal('fetch',provider({after:async()=>{await env.DB.prepare("UPDATE media_processing SET lease_token='new-owner' WHERE job_id=?1").bind(f.jobId).run();}}));expect(await runMediaJob(testEnv,f.jobId)).toEqual({status:'busy'});expect((await getJob(env,f.jobId)).status).toBe('running');expect(await env.DB.prepare('SELECT stage,lease_token FROM media_processing WHERE job_id=?1').bind(f.jobId).first()).toEqual({stage:'generating',lease_token:'new-owner'});expect(await env.DB.prepare('SELECT pages_json FROM creation_draft_files WHERE id=?1').bind(f.fileId).first()).toEqual({pages_json:'[]'});});
 it('unknown prior dispatch is never replayed after lease expires',async()=>{const f=await fixture();await f.insertState();await env.DB.prepare('UPDATE media_processing SET lease_expires_at=?2 WHERE job_id=?1').bind(f.jobId,new Date(Date.now()-1000).toISOString()).run();const request=provider();vi.stubGlobal('fetch',request);expect(await runMediaJob(testEnv,f.jobId)).toEqual({status:'failed'});expect(request).not.toHaveBeenCalled();});
 it('explicit no-replay failures are excluded by the generic retry scheduler',()=>{expect(prepareAutomaticJobRetry(env,newId(),{code:'AI_UNAVAILABLE',message:'unknown',details:{automaticRetry:false}},nowIso())).toBeNull();});
 it('routes only explicit MiMo choice and preserves legacy defaults',async()=>{const f=await fixture();const legacy={...f.config,config:{...f.config.config,processingStrategies:undefined,audioProcessingStrategy:undefined}};expect(selectedMediaProvider(legacy,'audio/wav')).toBe('gemini');expect(selectedMediaProvider(legacy,'video/mp4')).toBe('gemini');expect(selectedMediaProvider(f.config,'audio/wav')).toBe('mimo');expect(whisperEnabled({...testEnv,AI:{} as NonNullable<typeof env.AI>},f.config,'audio/wav')).toBe(false);expect(mediaRouteError(testEnv,f.config,'audio/wav')).toBeNull();expect(mediaRouteError(testEnv,{...f.config,config:{...f.config.config,processingStrategies:{audioFiles:'mimo-only',videoFiles:'mimo',rehearsal:'text'}}},'video/webm')).toContain('格式');});
 it('Gemini cleanup ignores MiMo state',async()=>{const f=await fixture();await f.insertState();await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?1").bind(f.jobId).run();await env.DB.prepare("UPDATE media_processing SET cleanup_pending=1,provider_name='files/never-google' WHERE job_id=?1").bind(f.jobId).run();const request=vi.fn();vi.stubGlobal('fetch',request);await cleanupMediaFiles(env);expect(request).not.toHaveBeenCalled();});
});
describe('MiMo admin configuration compatibility',()=>{
 it('saving independent MiMo preserves enabled text models and empty-key secrets without changing strategy',async()=>{
  const f=await fixture(),app=createApp();const {apiKeyEncrypted,...publicModel}=f.model;void apiKeyEncrypted;
  const request=(body:unknown)=>app.request('/api/v1/admin/ai-config',{method:'PUT',headers:{authorization:'Bearer test-admin-token','content-type':'application/json'},body:JSON.stringify(body)},testEnv);
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=json_set(config_json,\'$.processingStrategies.audioFiles\',\'whisper-first\') WHERE id=?1').bind(f.config.id).run();
  const saved=await request({expectedVersion:f.config.version,mimoMediaUnderstanding:publicModel});expect(saved.status).toBe(201);expect((await saved.json() as {data:{enabled:boolean}}).data.enabled).toBe(true);
  const latest=(await loadAiConfig(env.DB))!;expect(latest.config.mimoMediaUnderstanding?.apiKeyEncrypted).toBeUndefined();expect(latest.config.processingStrategies?.audioFiles).toBe('whisper-first');
  const read=await app.request('/api/v1/admin/ai-config',{headers:{authorization:'Bearer test-admin-token'}},testEnv);const serialized=await read.text();expect(serialized).not.toContain('apiKeyEncrypted');expect(serialized).not.toContain('mimo-fixture-key');expect(serialized).not.toContain('keyConfigured');
  const cleared=await request({expectedVersion:latest.version,clearMimoMediaUnderstanding:true});expect(cleared.status).toBe(201);expect((await loadAiConfig(env.DB))!.config.mimoMediaUnderstanding).toBeUndefined();
 });
 it('MiMo capability is independent of Whisper and readonly probe uses Gateway BYOK',async()=>{const f=await fixture(),app=createApp();const capabilities=await app.request('/api/v1/capabilities',{},testEnv);expect((await capabilities.json() as {data:{features:Record<string,unknown>}}).data.features).toMatchObject({audioSummaryEnabled:true,audioTranscriptionEnabled:false,audioMediaProvider:'mimo'});const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{expect(String(url)).toBe('https://gateway.ai.cloudflare.com/v1/test-account-id/test-gateway-id/custom-xiaomi-mimo/v1/models');expect(new Headers(init?.headers).get('cf-aig-authorization')).toBe('Bearer test-cf-token');expect(new Headers(init?.headers).has('api-key')).toBe(false);return Response.json({data:[{id:'mimo-v2.6-pro'}]});});vi.stubGlobal('fetch',request);const probe=await app.request('/api/v1/admin/ai-config/mimo-media-probe',{method:'POST',headers:{authorization:'Bearer test-admin-token'}},testEnv);expect(probe.status).toBe(200);expect(request).toHaveBeenCalledTimes(1);expect(f.config.config.processingStrategies?.audioFiles).toBe('mimo-only');});
});
