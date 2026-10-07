import { GeminiMediaClient } from '../src/ai/gemini-media';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiJsonCall } from '../src/services/agent';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env, AppEnv } from '../src/env';
import { env } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { AppError } from '../src/core/errors';
import { backgroundModelCall } from '../src/services/background-model-call';
import { ExecutionPaused, ensureExecution, pauseExecution, readExecution, resumeExecution, cancelExecution } from '../src/services/ai-execution-control';
import { activeExecutionSlice, BackgroundContinuation, executeAiSlice } from '../src/services/ai-execution-slices';
import { failJob, getJob, reconcileWorkflowJob, succeedJob } from '../src/services/jobs';
import { recoverAutomaticAiRetries } from '../src/services/ai-automatic-retries';
import { registerJobExecutionRoutes } from '../src/api/job-execution';

afterEach(()=>vi.unstubAllGlobals());
async function fixture(kind='agent_run'){
 const owner=await seedUser(),projectId=await seedProject(owner.userId),jobId=newId(),now=nowIso();
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,?3,'running','{}',?4,?5,?5)").bind(jobId,projectId,kind,owner.userId,now).run();
 const target={kind:'job' as const,id:jobId};await ensureExecution(env,target);return {owner,projectId,jobId,target};
}
function routes(){const app=new OpenAPIHono<AppEnv>();registerJobExecutionRoutes(app);app.onError((e,c)=>c.json({error:e instanceof AppError?{code:e.code,message:e.message}:{code:'INTERNAL'}},e instanceof AppError?e.status as 409:500));return app;}
describe('background processing windows',()=>{
 it('yields after one new generation and pauses the next window boundary without failure or retry',async()=>{
  const f=await fixture();await env.DB.prepare('UPDATE ai_executions SET call_limit=1 WHERE target_id=?1').bind(f.jobId).run();
  const local:Env={...env,AI_EXECUTION_CONTEXT:{modelCalls:0}},model=vi.fn(async()=>({text:'saved'}));
  await backgroundModelCall(local,f.jobId,model);
  await expect(backgroundModelCall(local,f.jobId,model)).rejects.toBeInstanceOf(BackgroundContinuation);
  await expect(backgroundModelCall({...env,AI_EXECUTION_CONTEXT:{modelCalls:0}},f.jobId,model)).rejects.toMatchObject({details:{executionPause:true}});
  expect(model).toHaveBeenCalledOnce();expect(await readExecution(env,f.target)).toMatchObject({windowCalls:1,totalCalls:1,state:'paused',pauseReason:'round_limit'});
  expect((await getJob(env,f.jobId)).status).toBe('waiting_input');
  expect(await failJob(env,f.jobId,{code:'AI_UNAVAILABLE',message:'transport'})).toBe(false);
  await resumeExecution(env,f.target,1,'continue');expect(await readExecution(env,f.target)).toMatchObject({generation:2,windowCalls:0,totalCalls:1,state:'running'});
 });
 it('continues beyond the old 511 slice limit with a deterministic successor',async()=>{
  const f=await fixture(),create=vi.fn(async()=>({})),local={...env,AGENT_WORKFLOW:{create}} as unknown as Env;
  await env.DB.prepare("INSERT INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) VALUES(?1,511,?2,'pending',?3,?3)").bind(f.jobId,`${f.jobId}-s511`,nowIso()).run();
  await executeAiSlice(local,f.jobId,511,async()=>{throw new BackgroundContinuation();});
  expect((await activeExecutionSlice(env,f.jobId))?.slice).toBe(512);expect(create).toHaveBeenCalledWith({id:`${f.jobId}-s512`,params:{jobId:f.jobId,slice:512}});
 });
 it('halts unknown requests and discards cancelled late responses',async()=>{
  const f=await fixture();await expect(backgroundModelCall(env,f.jobId,async()=>{throw new Error('network');})).rejects.toMatchObject({details:{executionPause:true}});
  expect(await readExecution(env,f.target)).toMatchObject({state:'paused',pauseReason:'request_uncertain',canContinue:false});
  const second=await fixture();await expect(backgroundModelCall(env,second.jobId,async()=>{await cancelExecution(env,second.target);return 'late';})).rejects.toThrow('迟到结果');
  expect(await readExecution(env,second.target)).toMatchObject({state:'cancelled',totalCalls:1});
 });
 it('preserves explicit HTTP rejection as known and pauses terminal interrupted engines',async()=>{
  const f=await fixture();await expect(backgroundModelCall(env,f.jobId,async()=>{throw Object.assign(new Error('unsupported'),{status:415});})).rejects.toThrow('unsupported');
  expect(await readExecution(env,f.target)).toMatchObject({state:'running',windowCalls:1});
  await env.DB.prepare("INSERT INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) VALUES(?1,0,?1,'running',?2,?2)").bind(f.jobId,nowIso()).run();
  await reconcileWorkflowJob({...env,AGENT_WORKFLOW:{get:async()=>({status:async()=>({status:'errored'})})}} as unknown as Env,f.jobId);
  expect(await readExecution(env,f.target)).toMatchObject({state:'paused',pauseReason:'interrupted'});expect((await getJob(env,f.jobId)).status).toBe('waiting_input');
 });
 it('does not schedule a pending automatic retry while waiting for a user window action',async()=>{
  const f=await fixture();await pauseExecution(env,f.target,'round_limit');const now=nowIso();
  await env.DB.prepare("INSERT INTO ai_automatic_retries(id,target_kind,target_id,status,next_attempt_at,created_at,updated_at) VALUES(?1,'job',?2,'pending',?3,?3,?3)").bind(newId(),f.jobId,now).run();
  const retry=vi.fn(async()=>({jobId:f.jobId}));await recoverAutomaticAiRetries(env,retry);expect(retry).not.toHaveBeenCalled();
 });
 it('outputs saved media coverage explicitly as partial and does not call a model',async()=>{
  const f=await fixture();await pauseExecution(env,f.target,'round_limit');
  const config=await env.DB.prepare('SELECT id FROM ai_config_versions LIMIT 1').first<{id:string}>();
  await env.DB.prepare("INSERT INTO audio_pipeline(job_id,config_version_id,phase,summaries_json,created_at,updated_at) VALUES(?1,?2,'summarized',?3,?4,?4)").bind(f.jobId,config!.id,JSON.stringify([{summary:'第一段已处理',complete:true}]),nowIso()).run();
  const create=vi.fn(),local={...env,AGENT_WORKFLOW:{create}} as unknown as Env;
  const response=await routes().request(`https://example.com/api/v1/jobs/${f.jobId}/execution/output`,{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json','idempotency-key':newId()},body:JSON.stringify({expectedGeneration:1})},local);
  expect(response.status).toBe(202);expect(create).not.toHaveBeenCalled();const job=await getJob(env,f.jobId);expect(JSON.parse(job.result_json!)).toMatchObject({partial:true,complete:false,coverage:{completedChunks:1}});expect(job.status).toBe('succeeded');
 });
 it('continues the same paused job once and preserves its media checkpoints on an idempotent replay',async()=>{
  const f=await fixture();await pauseExecution(env,f.target,'round_limit');const config=await env.DB.prepare('SELECT id FROM ai_config_versions LIMIT 1').first<{id:string}>();
  await env.DB.prepare("INSERT INTO audio_pipeline(job_id,config_version_id,phase,summaries_json,created_at,updated_at) VALUES(?1,?2,'summarized','[{\"summary\":\"已完成片段\"}]',?3,?3)").bind(f.jobId,config!.id,nowIso()).run();
  const create=vi.fn(async()=>({})),local={...env,AGENT_WORKFLOW:{create}} as unknown as Env,key=newId(),app=routes();
  const init={method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json','idempotency-key':key},body:'{"expectedGeneration":1}'};
  const first=await app.request(`https://example.com/api/v1/jobs/${f.jobId}/execution/continue`,init,local),second=await app.request(`https://example.com/api/v1/jobs/${f.jobId}/execution/continue`,init,local);
  expect(first.status).toBe(202);expect(second.status).toBe(202);expect(create).toHaveBeenCalledOnce();expect(await readExecution(env,f.target)).toMatchObject({generation:2,state:'running'});
  expect((await env.DB.prepare('SELECT summaries_json FROM audio_pipeline WHERE job_id=?1').bind(f.jobId).first<{summaries_json:string}>())?.summaries_json).toContain('已完成片段');
 });
 it('delivers OCR coverage without setting the unfinished source ready',async()=>{
  const f=await fixture('ocr_pages'),sourceId=newId(),versionId=newId(),now=nowIso();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'paste','资料',?3,?4,?5,?5)").bind(sourceId,f.projectId,versionId,f.owner.userId,now),
   env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','processing',?4)").bind(versionId,sourceId,f.projectId,now),
   env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,1,1,'ocr','已读取第一页',?4)").bind(newId(),versionId,f.projectId,now),
   env.DB.prepare("INSERT INTO source_pages(id,source_version_id,project_id,page_number,ocr_status,updated_at) VALUES(?1,?2,?3,1,'ok',?4)").bind(newId(),versionId,f.projectId,now),
   env.DB.prepare("INSERT INTO source_pages(id,source_version_id,project_id,page_number,ocr_status,updated_at) VALUES(?1,?2,?3,2,'pending',?4)").bind(newId(),versionId,f.projectId,now),
   env.DB.prepare('UPDATE jobs SET input_json=?2 WHERE id=?1').bind(f.jobId,JSON.stringify({sourceVersionId:versionId,sourceLifecycleVersion:1})),
  ]);await pauseExecution(env,f.target,'round_limit');
  const response=await routes().request(`https://example.com/api/v1/jobs/${f.jobId}/execution/output`,{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json','idempotency-key':newId()},body:'{"expectedGeneration":1}'},env);
  expect(response.status).toBe(202);expect(JSON.parse((await getJob(env,f.jobId)).result_json!)).toMatchObject({partial:true,complete:false,coverage:{completedPages:[1],remainingPages:[2]}});
  expect(await env.DB.prepare('SELECT status FROM source_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'processing'});
 });
 it('allows only one concurrent generation action and retains the winning reservation',async()=>{
  const f=await fixture();await pauseExecution(env,f.target,'round_limit');const create=vi.fn(async()=>({})),local={...env,AGENT_WORKFLOW:{create}} as unknown as Env,app=routes();
  const invoke=()=>app.request(`https://example.com/api/v1/jobs/${f.jobId}/execution/continue`,{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json','idempotency-key':newId()},body:'{"expectedGeneration":1}'},local);
  const responses=await Promise.all([invoke(),invoke()]);expect(responses.map(r=>r.status).sort()).toEqual([202,409]);expect(create).toHaveBeenCalledOnce();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE job_id=?1 AND status='reserved'").bind(f.jobId).first()).toEqual({n:1});
  expect(await readExecution(env,f.target)).toMatchObject({generation:2,state:'running'});
 });
 it('atomically fences job publication during cancellation and ignores stale generations',async()=>{
  const f=await fixture();await cancelExecution(env,f.target,1);await succeedJob(env,f.jobId,{late:true});expect((await getJob(env,f.jobId)).status).toBe('cancelled');expect((await getJob(env,f.jobId)).result_json).toBeNull();
  const other=await fixture();await pauseExecution(env,other.target,'round_limit');await resumeExecution(env,other.target,1,'continue');await env.DB.prepare("UPDATE jobs SET status='running' WHERE id=?1").bind(other.jobId).run();
  await succeedJob({...env,AI_EXECUTION_CONTEXT:{modelCalls:0,generation:1}},other.jobId,{stale:true});expect((await getJob(env,other.jobId)).status).toBe('running');expect((await getJob(env,other.jobId)).result_json).toBeNull();
 });
 it('stops an old media worker without consuming or pausing the new finalization generation',async()=>{
  const f=await fixture();await pauseExecution(env,f.target,'round_limit');await resumeExecution(env,f.target,1,'output');const call=vi.fn(async()=>({}));
  await expect(backgroundModelCall({...env,AI_EXECUTION_CONTEXT:{modelCalls:0,generation:1}},f.jobId,call)).rejects.toMatchObject({details:{executionSuperseded:true}});expect(call).not.toHaveBeenCalled();
  expect(await readExecution(env,f.target)).toMatchObject({generation:2,state:'finalizing',totalCalls:0});
 });
 it('keeps a committed job success consistent when cancellation arrives before control completion',async()=>{
  const f=await fixture();await env.DB.prepare("UPDATE jobs SET status='succeeded' WHERE id=?1").bind(f.jobId).run();await expect(cancelExecution(env,f.target,1)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  expect(await readExecution(env,f.target)).toMatchObject({state:'running'});expect((await getJob(env,f.jobId)).status).toBe('succeeded');
 });
 it('does not release a resumed window slot from a late pause handler',async()=>{
  const f=await fixture();await reserveAiSlot(env,{projectId:f.projectId,jobId:f.jobId,purpose:'agent_run'});
  await env.DB.prepare("INSERT INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) VALUES(?1,0,?1,'pending',?2,?2)").bind(f.jobId,nowIso()).run();
  await executeAiSlice(env,f.jobId,0,async()=>{
    await pauseExecution(env,f.target,'round_limit');const stopped=new ExecutionPaused((await readExecution(env,f.target))!);
    await resumeExecution(env,f.target,1,'continue');await env.DB.prepare("UPDATE jobs SET status='running' WHERE id=?1").bind(f.jobId).run();
    await reserveAiSlot(env,{projectId:f.projectId,jobId:f.jobId,purpose:'execution_resume'});throw stopped;
  });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE job_id=?1 AND status='reserved'").bind(f.jobId).first()).toEqual({n:1});expect(await readExecution(env,f.target)).toMatchObject({state:'running',generation:2});
 });
 it.each(['invalid-json','http-rejection'] as const)('pauses one explicit final output after %s without marking the job failed',async mode=>{
  await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;await pauseExecution(env,f.target,'round_limit');await resumeExecution(env,f.target,1,'output');await env.DB.prepare("UPDATE jobs SET status='running' WHERE id=?1").bind(f.jobId).run();await reserveAiSlot(env,{projectId:f.projectId,jobId:f.jobId,purpose:'execution_resume'});
  const request=vi.fn(async()=>mode==='http-rejection'?Response.json({error:{message:'invalid input'}},{status:400}):Response.json({choices:[{message:{content:'invalid json'}}],usage:{prompt_tokens:10,completion_tokens:10}}));vi.stubGlobal('fetch',request);
  await expect(aiJsonCall({...env,AI_EXECUTION_CONTEXT:{modelCalls:0,generation:2}},{projectId:f.projectId,jobId:f.jobId,purpose:'textEconomy',configVersionId:config.id,model:config.config.textEconomy.model,modelConfig:config.config.textEconomy,promptVersion:'explicit-output-test',schema:z.object({summary:z.string()}),messages:[{role:'user',content:'输出当前结果'}]})).rejects.toMatchObject({details:{executionPause:true}});
  expect(request).toHaveBeenCalledOnce();expect(await readExecution(env,f.target)).toMatchObject({state:'paused',pauseReason:'output_invalid',totalCalls:1});expect((await getJob(env,f.jobId)).status).toBe('waiting_input');
 });
 it('repairs multiple invalid outputs across independent slices without replaying rejected responses',async()=>{
  await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;
  await reserveAiSlot(env,{projectId:f.projectId,jobId:f.jobId,purpose:'agent_run'});
  const request=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({summary:request.mock.calls.length<4?1:'已修正'})}}],usage:{prompt_tokens:10,completion_tokens:10}}));vi.stubGlobal('fetch',request);
  await env.DB.prepare("INSERT INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) VALUES(?1,0,?1,'pending',?2,?2)").bind(f.jobId,nowIso()).run();
  const local={...env,AGENT_WORKFLOW:{create:vi.fn(async()=>({}))}} as unknown as Env;
  for(let slice=0;slice<5;slice++){
    const sliceEnv={...local,AI_EXECUTION_SLICE:true as const,AI_EXECUTION_CONTEXT:{modelCalls:0}};
    await executeAiSlice(sliceEnv,f.jobId,slice,async()=>{
      const result=await aiJsonCall(sliceEnv,{projectId:f.projectId,jobId:f.jobId,purpose:'textEconomy',configVersionId:config.id,model:config.config.textEconomy.model,modelConfig:config.config.textEconomy,promptVersion:'window-repair-test',schema:z.object({summary:z.string()}),messages:[{role:'user',content:'输出JSON'}]});
      const {succeedJob}=await import('../src/services/jobs');await succeedJob(env,f.jobId,result.data);
    });
    if((await getJob(env,f.jobId)).status==='succeeded')break;
  }
  expect(request).toHaveBeenCalledTimes(4);expect((await getJob(env,f.jobId)).status).toBe('succeeded');expect(await readExecution(env,f.target)).toMatchObject({totalCalls:4,state:'completed'});
 });
 it.each([400,'invalid-json'] as const)('keeps a received Gemini response %s distinct from an unknown network request',async responseKind=>{
  const f=await fixture(),config=(await loadAiConfig(env.DB))!,request=vi.fn(async()=>responseKind===400?new Response('{}',{status:400}):new Response('invalid-json'));
  const client=new GeminiMediaClient({...config.config.textEconomy,provider:'google-gemini',providerPreset:'gemini',model:'gemini-test',apiUrl:'https://generativelanguage.googleapis.com'},'fixture-key',request);
  await expect(backgroundModelCall(env,f.jobId,()=>client.summarize({name:'files/test',uri:'https://generativelanguage.googleapis.com/v1beta/files/test'},'video/mp4'))).rejects.toMatchObject(responseKind===400?{details:{status:400}}:{code:'AI_OUTPUT_INVALID'});
  expect(await readExecution(env,f.target)).toMatchObject({state:'running',totalCalls:1,pauseReason:null});
 });
 it('rejects other project members using the original actor restriction',async()=>{
  const f=await fixture(),other=await seedUser();await pauseExecution(env,f.target,'round_limit');
  await env.DB.prepare("INSERT INTO project_members(project_id,user_id,role,joined_at) VALUES(?1,?2,'member',?3)").bind(f.projectId,other.userId,nowIso()).run();
  const res=await routes().request(`https://example.com/api/v1/jobs/${f.jobId}/execution/continue`,{method:'POST',headers:{cookie:authCookie(other.token),'content-type':'application/json','idempotency-key':newId()},body:'{"expectedGeneration":1}'},env);expect(res.status).toBe(403);
 });
});
