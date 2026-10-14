import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { aiQuotaDay, claimAiResource, finishAiResource, OPERATOR_TOKEN_AI_ACTOR, releaseAiResourceWithEvidence, ResourceConcurrencyWait, withAiResourceDispatch } from '../src/services/ai-resource-quota';
import { loadResourcePolicy, saveResourcePolicy } from '../src/services/resource-policy';
import { readResourceUsage, registerResourceUsageRoutes } from '../src/api/resource-usage';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../src/env';
import { GeminiMediaClient, GOOGLE_MEDIA_ENDPOINT } from '../src/ai/gemini-media';
import { MimoMediaClient, MIMO_MEDIA_ENDPOINT, MIMO_MEDIA_MODEL } from '../src/ai/mimo-media';
import { configureGoFixture } from './helpers/provider-config';
import { probeModel } from '../src/ai/probe';
import { scheduleAutomaticDraftRetry } from '../src/services/ai-automatic-retries';
import { backgroundModelCall } from '../src/services/background-model-call';
import { gatewayChat } from '../src/ai/gateway';
import { seal } from '../src/ai/secrets';
import { AppError } from '../src/core/errors';
import { registerAdminRoutes } from '../src/api/admin';

async function configure(patch:Partial<Awaited<ReturnType<typeof loadResourcePolicy>>>){const current=await loadResourcePolicy(env),{version,...policy}=current;return saveResourcePolicy(env,version,{...policy,...patch},null);}
async function fixture(){const user=await seedUser(),projectId=await seedProject(user.userId),jobId=newId(),now=nowIso();await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running',?3,?4,?4)").bind(jobId,projectId,JSON.stringify({requestedBy:user.userId}),now).run();return {userId:user.userId,projectId,jobId};}
const count=async()=> (await env.DB.prepare("SELECT calls FROM ai_resource_daily WHERE quota_day=?1 AND scope='platform'").bind(aiQuotaDay()).first<{calls:number}>())?.calls??0;
beforeEach(async()=>{await env.DB.batch([env.DB.prepare('DELETE FROM ai_resource_dispatches'),env.DB.prepare('DELETE FROM ai_resource_daily'),env.DB.prepare('DELETE FROM storage_objects'),env.DB.prepare('DELETE FROM storage_reservations'),env.DB.prepare('DELETE FROM storage_counters'),env.DB.prepare('UPDATE storage_inventory_state SET ready=0,external_checked_at=NULL WHERE id=1'),env.DB.prepare("UPDATE resource_policy SET policy_json=json_set(policy_json,'$.aiEnabled',json('true'),'$.userDailyCalls',300,'$.projectDailyCalls',1000,'$.platformDailyCalls',5000,'$.globalConcurrency',10) WHERE id=1")]);});

describe('atomic UTC+8 resource dispatch quota',()=>{
  it('uses Beijing midnight rather than host/local timezone',()=>{expect(aiQuotaDay(new Date('2026-10-14T15:59:59Z'))).toBe('2026-10-14');expect(aiQuotaDay(new Date('2026-10-14T16:00:00Z'))).toBe('2026-10-15');});
  it('serializes simultaneous last-user-slot admission and does not refund real failures',async()=>{
    const context=await fixture();await configure({userDailyCalls:1});const results=await Promise.allSettled(Array.from({length:8},()=>claimAiResource(env,context)));
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await count()).toBe(1);
    const result=results.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<{id:string}>;await finishAiResource(env,result.value,'completed');expect(await count()).toBe(1);
    await expect(claimAiResource(env,context)).rejects.toMatchObject({code:'QUOTA_EXCEEDED',retryable:false,details:{automaticRetry:false}});
  });
  it('enforces project and platform limits across distinct actors',async()=>{
    const first=await fixture(),second=await fixture();await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),first.projectId,second.userId,nowIso()).run();await configure({projectDailyCalls:1,platformDailyCalls:2});const claim=await claimAiResource(env,first);await finishAiResource(env,claim,'completed');
    await expect(claimAiResource(env,{userId:second.userId,projectId:first.projectId})).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
    const other=await claimAiResource(env,second);await finishAiResource(env,other,'completed');await expect(claimAiResource(env,{userId:newId()})).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});expect(await count()).toBe(2);
  });
  it('global contention waits without consuming daily calls or the execution window',async()=>{
    const first=await fixture(),second=await fixture();await configure({globalConcurrency:1});await claimAiResource(env,first);
    const provider=vi.fn();await expect(backgroundModelCall(env,second.jobId,provider)).rejects.toBeInstanceOf(ResourceConcurrencyWait);
    expect(provider).not.toHaveBeenCalled();expect(await count()).toBe(1);expect(await env.DB.prepare('SELECT 1 FROM ai_executions WHERE target_id=?1').bind(second.jobId).first()).toBeNull();
  });
  it('grants no more than ten simultaneously active platform dispatches',async()=>{
    const context=await fixture(),results=await Promise.allSettled(Array.from({length:25},()=>claimAiResource(env,context)));expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(10);expect(await count()).toBe(10);
  });
  it('keeps unknown acceptance fenced, while a pre-dispatch cancellation refunds once',async()=>{
    await configure({globalConcurrency:1});const context=await fixture(),claim=await claimAiResource(env,context);await finishAiResource(env,claim,'cancelled');await finishAiResource(env,claim,'cancelled');expect(await count()).toBe(0);
    await expect(withAiResourceDispatch(env,context,async()=>{throw new Error('network lost');})).rejects.toThrow('network lost');expect(await count()).toBe(1);
    expect(await env.DB.prepare("SELECT status,lease_until FROM ai_resource_dispatches WHERE status='uncertain'").first()).toMatchObject({status:'uncertain',lease_until:null});await expect(claimAiResource(env,context)).rejects.toBeInstanceOf(ResourceConcurrencyWait);
  });
  it('blocks duplicates and an administratively disabled platform without dispatch',async()=>{
    const context=await fixture(),claim=await claimAiResource(env,context,{dispatchKey:'stable'});await finishAiResource(env,claim,'completed');await expect(claimAiResource(env,context,{dispatchKey:'stable'})).rejects.toMatchObject({code:'INVALID_STATE'});
    await configure({aiEnabled:false});await expect(claimAiResource(env,context)).rejects.toMatchObject({code:'AI_UNAVAILABLE',details:{resourceQuota:true}});expect(await count()).toBe(1);
  });
  it('charges each provider retry while withholding exhausted retries',async()=>{
    const user=await seedUser();await configure({userDailyCalls:1});const provider=vi.fn(async()=>new Response('{}',{status:503}));const key=await seal('key',env.AUTH_SECRET);
    await expect(gatewayChat({accountId:'',apiToken:'',gatewayId:'',authSecret:env.AUTH_SECRET,envName:'local',diagnostics:env},{resourceUserId:user.userId,config:{provider:'openai-compatible',model:'m',apiUrl:'https://models.example/v1/chat/completions',apiKeyEncrypted:key,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:false},messages:[{role:'user',content:'test'}]},provider,async()=>{})).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
    expect(provider).toHaveBeenCalledOnce();expect(await count()).toBe(1);
  });
  it('does not charge malformed payloads rejected before outbound dispatch',async()=>{
    const user=await seedUser(),key=await seal('key',env.AUTH_SECRET),provider=vi.fn();await expect(gatewayChat({accountId:'',apiToken:'',gatewayId:'',authSecret:env.AUTH_SECRET,envName:'local',diagnostics:env},{resourceUserId:user.userId,config:{provider:'openai-compatible',model:'m',apiUrl:'https://models.example/v1/chat/completions',apiKeyEncrypted:key,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:true},messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,invalid'}}]}]},provider)).rejects.toBeInstanceOf(AppError);expect(provider).not.toHaveBeenCalled();expect(await count()).toBe(0);
  });
  it('rechecks the kill switch after a slow final permission guard and cancels without charge',async()=>{
    const context=await fixture(),provider=vi.fn(),key=await seal('key',env.AUTH_SECRET);
    await expect(gatewayChat({accountId:'',apiToken:'',gatewayId:'',authSecret:env.AUTH_SECRET,envName:'local',diagnostics:env},{jobId:context.jobId,config:{provider:'openai-compatible',model:'m',apiUrl:'https://models.example/v1/chat/completions',apiKeyEncrypted:key,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:false},messages:[{role:'user',content:'fixture'}],beforeFetch:async()=>{await configure({aiEnabled:false});}},provider)).rejects.toMatchObject({code:'AI_UNAVAILABLE',details:{resourceQuota:true}});expect(provider).not.toHaveBeenCalled();expect(await count()).toBe(0);
  });
  it('shows only personal and authorized project usage and both stored/reserved bytes',async()=>{
    const first=await fixture(),other=await fixture();const claim=await claimAiResource(env,first);await finishAiResource(env,claim,'completed');await env.DB.batch([env.DB.prepare("INSERT INTO storage_objects(object_key,size_bytes,project_id,user_id,category,etag,updated_at) VALUES('visible',100,?1,?2,'upload',NULL,?3)").bind(first.projectId,first.userId,nowIso()),env.DB.prepare("INSERT INTO storage_reservations(id,object_key,bytes,project_id,user_id,category,kind,status,upload_id,expires_at,updated_at) VALUES('pending','pending',50,?1,?2,'upload','put','reserved',NULL,?3,?3)").bind(first.projectId,first.userId,new Date(Date.now()+60000).toISOString())]);
    const usage=await readResourceUsage(env,first.userId,first.projectId);expect(usage.ai.user.used).toBe(1);expect(usage.ai.project?.used).toBe(1);expect(usage.storage.user).toMatchObject({used:100,reserved:50,remaining:249999850});await expect(readResourceUsage(env,first.userId,other.projectId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(JSON.stringify(usage)).not.toContain(other.userId);
  });
  it('attributes a member-initiated job to created_by rather than the project owner',async()=>{
    const owner=await fixture(),member=await seedUser();await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),owner.projectId,member.userId,nowIso()).run();await env.DB.prepare("UPDATE jobs SET input_json='{}',created_by=?2 WHERE id=?1").bind(owner.jobId,member.userId).run();
    const claim=await claimAiResource(env,{jobId:owner.jobId});await finishAiResource(env,claim,'completed');expect((await readResourceUsage(env,member.userId)).ai.user.used).toBe(1);expect((await readResourceUsage(env,owner.userId)).ai.user.used).toBe(0);
  });
  it('charges only real media generation, excluding metadata and cached provider envelopes',async()=>{
    const context=await fixture(),summary={title:'summary',summary:'content',keyPoints:[],conclusions:[],actionItems:[],timestamps:[],caveats:[],complete:true,durationSeconds:30};
    const geminiRaw={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(summary)}]}}]};
    const geminiFetch=vi.fn(async()=>Response.json(geminiRaw)),gemini=new GeminiMediaClient({provider:'google-gemini',model:'gemini-test',apiUrl:GOOGLE_MEDIA_ENDPOINT,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:true},'key',geminiFetch,env,context.jobId);
    await gemini.summarize({name:'files/fixture',uri:GOOGLE_MEDIA_ENDPOINT+'/v1beta/files/fixture'},'audio/wav');expect(await count()).toBe(1);
    await configure({aiEnabled:false});await gemini.summarize({name:'files/fixture',uri:GOOGLE_MEDIA_ENDPOINT+'/v1beta/files/fixture'},'audio/wav',0,undefined,undefined,{cached:geminiRaw,save:async()=>{}});expect(geminiFetch).toHaveBeenCalledOnce();expect(await count()).toBe(1);
    const mimoFetch=vi.fn(async()=>Response.json({data:[{id:MIMO_MEDIA_MODEL}]})),mimo=new MimoMediaClient({provider:'xiaomi-mimo',model:MIMO_MEDIA_MODEL,apiUrl:MIMO_MEDIA_ENDPOINT,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:true},'key',mimoFetch,env,context.jobId);
    expect(await mimo.probe()).toBe(true);await expect(mimo.summarize('https://media.example/audio.wav','audio/wav')).rejects.toMatchObject({code:'AI_UNAVAILABLE',details:{resourceQuota:true}});expect(mimoFetch).toHaveBeenCalledOnce();expect(await count()).toBe(1);
  });
  it('applies the platform kill switch to real capability probes',async()=>{
    await configureGoFixture();await configure({aiEnabled:false});const user=await seedUser(),provider=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('unexpected outbound call');});
    try{await expect(probeModel(env,'textEconomy',undefined,newId(),user.userId)).rejects.toMatchObject({code:'AI_UNAVAILABLE',details:{resourceQuota:true}});expect(provider).not.toHaveBeenCalled();expect(await count()).toBe(0);}finally{provider.mockRestore();}
  });
  it('refunds the media execution window when a transport quota guard stops admission',async()=>{
    const context=await fixture();await configure({userDailyCalls:1});const first=await claimAiResource(env,context);await finishAiResource(env,first,'completed');const request=vi.fn(),executionEnv={...env,AI_EXECUTION_CONTEXT:{modelCalls:0}},mimo=new MimoMediaClient({provider:'xiaomi-mimo',model:MIMO_MEDIA_MODEL,apiUrl:MIMO_MEDIA_ENDPOINT,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:true},'key',request,env,context.jobId);
    await expect(backgroundModelCall(executionEnv,context.jobId,()=>mimo.summarize('https://media.example/audio.wav','audio/wav'),true)).rejects.toMatchObject({code:'QUOTA_EXCEEDED',details:{resourceQuota:true}});expect(request).not.toHaveBeenCalled();expect(executionEnv.AI_EXECUTION_CONTEXT.modelCalls).toBe(0);expect(await env.DB.prepare('SELECT window_calls,inflight_token FROM ai_executions WHERE target_id=?1').bind(context.jobId).first()).toMatchObject({window_calls:0,inflight_token:null});expect(await count()).toBe(1);
  });
  it('does not let cloud callers omit the complete resource environment',async()=>{
    const provider=vi.fn();await expect(gatewayChat({accountId:'',apiToken:'',gatewayId:'',envName:'production'},{config:{provider:'openai-compatible',model:'m',apiUrl:'https://models.example/v1/chat/completions',timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:false},messages:[{role:'user',content:'fixture'}]},provider)).rejects.toMatchObject({details:{resourceQuota:true}});expect(provider).not.toHaveBeenCalled();expect(await count()).toBe(0);
  });
  it('rejects production requests without an actor even when storage is ready',async()=>{
    await env.DB.prepare('UPDATE storage_inventory_state SET ready=1,external_checked_at=?1 WHERE id=1').bind(nowIso()).run();const request=vi.fn();await expect(withAiResourceDispatch({...env,ENV_NAME:'production'}, {},request)).rejects.toMatchObject({code:'PERMISSION_DENIED',details:{automaticRetry:false}});expect(request).not.toHaveBeenCalled();expect(await count()).toBe(0);
  });
  it('checks membership inside admission after an earlier authorization becomes stale',async()=>{
    const context=await fixture(),request=vi.fn(),revoking={...env,DB:{prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(context.projectId,context.userId).run();return env.DB.batch(statements);}} as unknown as typeof env.DB};
    await expect(withAiResourceDispatch(revoking,context,request)).rejects.toMatchObject({code:'PERMISSION_DENIED',retryable:false,details:{automaticRetry:false}});expect(request).not.toHaveBeenCalled();expect(await count()).toBe(0);
    const whisper=vi.fn();await expect(backgroundModelCall(env,context.jobId,whisper)).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(whisper).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT 1 FROM ai_executions WHERE target_id=?1').bind(context.jobId).first()).toBeNull();
    const provider=vi.fn(),wait=vi.fn(),key=await seal('key',env.AUTH_SECRET);await expect(gatewayChat({accountId:'',apiToken:'',gatewayId:'',authSecret:env.AUTH_SECRET,envName:'local',diagnostics:env},{jobId:context.jobId,config:{provider:'openai-compatible',model:'m',apiUrl:'https://models.example/v1/chat/completions',apiKeyEncrypted:key,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:false},messages:[{role:'user',content:'fixture'}]},provider,wait)).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(provider).not.toHaveBeenCalled();expect(wait).not.toHaveBeenCalled();
  });
  it('meters all Bearer capability probes under one 300-call actor and preserves prior diagnostic success on rejection',async()=>{
    await configureGoFixture();const {loadAiConfig}=await import('../src/ai/config'),loaded=(await loadAiConfig(env.DB))!,original='{"passed":true,"marker":"prior-success"}',day=aiQuotaDay();
    await env.DB.batch([env.DB.prepare('UPDATE storage_inventory_state SET ready=1,external_checked_at=?1 WHERE id=1').bind(nowIso()),env.DB.prepare("INSERT INTO ai_resource_daily VALUES(?1,'platform','global',299)").bind(day),env.DB.prepare("INSERT INTO ai_resource_daily VALUES(?1,'user',?2,299)").bind(day,OPERATOR_TOKEN_AI_ACTOR),env.DB.prepare('INSERT OR REPLACE INTO ai_probes(config_version_id,purpose,passed,report_json,tested_at) VALUES(?1,?2,1,?3,?4)').bind(loaded.id,'textEconomy',original,nowIso())]);
    const app=new OpenAPIHono<AppEnv>();app.use('*',async(c,next)=>{c.set('requestId',newId());await next();});app.onError(error=>new Response(error.message,{status:error instanceof AppError?error.status:500}));registerAdminRoutes(app);
    const provider=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({choices:[{message:{content:'你好，测试内容。'}}],usage:{prompt_tokens:1,completion_tokens:1}})),before=(await env.DB.prepare('SELECT COUNT(*) n FROM ai_calls').first<{n:number}>())!.n;
    try{for(let index=0;index<2;index++){const response=await app.request('/api/v1/admin/ai-config/probe',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},body:'{"purpose":"textEconomy"}'},{...env,ENV_NAME:'production'});expect(response.status).toBe(429);}expect(provider).toHaveBeenCalledOnce();expect(await env.DB.prepare("SELECT calls FROM ai_resource_daily WHERE quota_day=?1 AND scope='user' AND scope_id=?2").bind(day,OPERATOR_TOKEN_AI_ACTOR).first()).toEqual({calls:300});expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_calls').first<{n:number}>())!.n-before).toBe(1);expect(await env.DB.prepare('SELECT passed,report_json FROM ai_probes WHERE config_version_id=?1 AND purpose=?2').bind(loaded.id,'textEconomy').first()).toEqual({passed:1,report_json:original});}finally{provider.mockRestore();}
  });
  it('blocks a held-resource release if super-admin authority is revoked before its transaction',async()=>{
    const user=await seedUser(),context=await fixture(),claim=await claimAiResource(env,context);await finishAiResource(env,claim,'uncertain');await env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin' WHERE user_id=?1").bind(user.userId).run();
    const revoking={DB:{prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{await env.DB.prepare("UPDATE auth_accounts SET account_role='user' WHERE user_id=?1").bind(user.userId).run();return env.DB.batch(statements);}} as unknown as typeof env.DB};
    await expect(releaseAiResourceWithEvidence(revoking,claim.id,user.userId,'供应商已确认请求处理结束')).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(await env.DB.prepare('SELECT status FROM ai_resource_dispatches WHERE id=?1').bind(claim.id).first()).toEqual({status:'uncertain'});expect(await env.DB.prepare('SELECT 1 FROM ai_resource_release_audit WHERE dispatch_id=?1').bind(claim.id).first()).toBeNull();expect(await count()).toBe(1);
  });
  it('does not spend automatic retry attempts on a disabled or quota-blocked draft',async()=>{
    const prepare=vi.fn(()=>{throw new Error('no scheduling DB access expected');}),blocked=new AppError('AI_UNAVAILABLE','platform disabled',503,false,{resourceQuota:true,automaticRetry:false});await scheduleAutomaticDraftRetry({...env,DB:{prepare} as unknown as typeof env.DB},newId(),newId(),blocked);expect(prepare).not.toHaveBeenCalled();
  });
  it('blocks paid production dispatch before inventory, after stale external checks and at full storage',async()=>{
    const context=await fixture(),production={...env,ENV_NAME:'production' as const},provider=vi.fn(async()=>({ok:true}));
    await expect(withAiResourceDispatch(production,context,provider)).rejects.toMatchObject({details:{storageInventoryRequired:true}});
    await env.DB.prepare("UPDATE storage_inventory_state SET ready=1,external_checked_at='2000-01-01T00:00:00.000Z' WHERE id=1").run();await expect(withAiResourceDispatch(production,context,provider)).rejects.toMatchObject({details:{storageInventoryRequired:true}});
    await env.DB.prepare('UPDATE storage_inventory_state SET external_checked_at=?1 WHERE id=1').bind(nowIso()).run();await env.DB.prepare("INSERT INTO storage_counters VALUES('platform','all',10000000000)").run();await expect(withAiResourceDispatch(production,context,provider)).rejects.toMatchObject({details:{storageQuota:true}});
    expect(provider).not.toHaveBeenCalled();expect(await count()).toBe(0);await env.DB.prepare("UPDATE storage_counters SET bytes=0 WHERE scope='platform' AND scope_id='all'").run();await expect(withAiResourceDispatch(production,context,provider)).resolves.toEqual({ok:true});expect(await count()).toBe(1);
  });
  it('holds concurrency when a successful HTTP header is followed by a broken response body',async()=>{
    const context=await fixture(),key=await seal('key',env.AUTH_SECRET),stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"choices":'));controller.error(new Error('lost body'));}}),provider=vi.fn(async()=>new Response(stream));
    await expect(gatewayChat({accountId:'',apiToken:'',gatewayId:'',authSecret:env.AUTH_SECRET,envName:'local',diagnostics:env},{jobId:context.jobId,config:{provider:'openai-compatible',model:'m',apiUrl:'https://models.example/v1/chat/completions',apiKeyEncrypted:key,timeoutMs:1000,maxInputChars:4000,supportsJson:true,supportsVision:false},messages:[{role:'user',content:'fixture'}]},provider)).rejects.toMatchObject({details:{executionPause:true}});
    expect(await count()).toBe(1);expect(await env.DB.prepare("SELECT status,lease_until FROM ai_resource_dispatches WHERE status='uncertain'").first()).toMatchObject({status:'uncertain',lease_until:null});expect(provider).toHaveBeenCalledOnce();
  });
  it('requires a super-admin cookie, an explicit supplier confirmation and an audited reason',async()=>{
    const ordinary=await seedUser(),operator=await seedUser();await env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin' WHERE user_id=?1").bind(operator.userId).run();const context=await fixture(),claim=await claimAiResource(env,context);await finishAiResource(env,claim,'uncertain');
    const app=new OpenAPIHono<AppEnv>();app.use('*',async(c,next)=>{c.set('requestId',newId());await next();});app.onError(error=>new Response(error.message,{status:error instanceof AppError?error.status:500}));registerResourceUsageRoutes(app);
    const path='/api/v1/admin/ai-resource-dispatches',headers={cookie:authCookie(operator.token),'content-type':'application/json'};
    expect((await app.request(path,{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}},env)).status).toBe(401);expect((await app.request(path,{headers:{cookie:authCookie(ordinary.token)}},env)).status).toBe(403);
    expect((await app.request(path+'/'+claim.id+'/release',{method:'POST',headers,body:JSON.stringify({providerConfirmedEnded:false,reason:'已核实供应商侧处理结束'})},env)).status).toBe(400);
    expect((await app.request(path+'/'+claim.id+'/release',{method:'POST',headers,body:JSON.stringify({providerConfirmedEnded:true,reason:'已核实供应商侧处理结束'})},env)).status).toBe(200);expect(await count()).toBe(1);expect(await env.DB.prepare('SELECT actor_id,reason FROM ai_resource_release_audit WHERE dispatch_id=?1').bind(claim.id).first()).toMatchObject({actor_id:operator.userId,reason:'已核实供应商侧处理结束'});
    expect((await app.request(path,{headers},env)).headers.get('Cache-Control')).toBe('private, no-store');
  });
});
