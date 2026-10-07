import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env } from './helpers/env';
import { seedUser, seedProject } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { newId, nowIso } from '../src/core/db';
import { aiJsonCall } from '../src/services/agent';
import { checkpointRootId, checkpointFingerprint, allowsUncertainCheckpointRetry, loadResponseCheckpoint, saveResponseCheckpoint } from '../src/services/ai-checkpoints';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { retryFailedAiJob } from '../src/services/admin-ai-retries';
import { loadInvestigation, saveInvestigation } from '../src/services/project-investigation';
afterEach(()=>vi.unstubAllGlobals());
async function fixture() {
  await configureGoFixture();const user=await seedUser(),projectId=await seedProject(user.userId),config=(await loadAiConfig(env.DB))!,jobId=newId(),now=nowIso();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'assignment_suggest','running',?3,?4,?5,?5)").bind(jobId,projectId,JSON.stringify({projectId,requestedBy:user.userId,configVersionId:config.id}),user.userId,now).run();
  await reserveAiSlot(env,{projectId,jobId,purpose:'assignment_suggest',maxCalls:2,configVersionId:config.id});
  return {user,projectId,config,jobId};
}
it('reuses an encrypted paid response after a business failure with a new execution ID',async()=>{
  const f=await fixture();const fetch=vi.fn(async()=>Response.json({choices:[{message:{content:'{"title":"private paid output"}'}}],usage:{prompt_tokens:10,completion_tokens:5}}));vi.stubGlobal('fetch',fetch);
  const params={projectId:f.projectId,jobId:f.jobId,purpose:'textEconomy' as const,configVersionId:f.config.id,model:f.config.config.textEconomy.model,modelConfig:f.config.config.textEconomy,promptVersion:'checkpoint-test',messages:[{role:'user' as const,content:'generate'}],schema:z.object({title:z.string()})};
  expect((await aiJsonCall(env,params)).data.title).toBe('private paid output');
  await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?1").bind(f.jobId).run();
  const retry=await retryFailedAiJob(env,f.jobId,undefined,undefined,{actorId:f.user.userId,allowUncertainDispatch:true});expect(retry.status).toBe('queued');
  expect(await checkpointRootId(env,retry.jobId!)).toBe(f.jobId);
  expect((await aiJsonCall(env,{...params,jobId:retry.jobId!})).data.title).toBe('private paid output');expect(fetch).toHaveBeenCalledTimes(1);
  const objects=await env.FILES.list({prefix:`ai/responses/${f.jobId}/`});
  expect(await (await env.FILES.get(objects.objects[0]!.key))!.text()).not.toContain('private paid output');
});
it('unknown dispatch requires explicit retry and preserves completed investigation steps',async()=>{
  const f=await fixture(),id=f.jobId+'-unknown';
  await saveInvestigation(env,{projectId:f.projectId,userId:f.user.userId,jobId:f.jobId},id,'unknown',{step:4,exchanges:[],references:[],trace:[{name:'read_task',status:'ok'}],pendingDispatch:true});
  await expect(loadInvestigation(env,id)).rejects.toThrow('结果未确认');
  const restored=await loadInvestigation(env,id,true);expect(restored?.step).toBe(4);expect(restored?.trace).toHaveLength(1);expect(restored?.pendingDispatch).toBe(false);
});
it('response encryption preserves long multilingual output and authenticates the storage key',async()=>{
  const key='ai/responses/'+newId(),value={content:'中文🙂'.repeat(12000)};
  await saveResponseCheckpoint(env,key,value);expect(await loadResponseCheckpoint(env,key)).toEqual(value);
  const stored=await env.FILES.get(key);await env.FILES.put(key+'-other',await stored!.text());
  await expect(loadResponseCheckpoint(env,key+'-other')).rejects.toThrow('内容不匹配');
});
it('manual retry rejects a different actor and keeps uncertain retry authorization on the new attempt only',async()=>{
  const f=await fixture();await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?1").bind(f.jobId).run();
  expect((await retryFailedAiJob(env,f.jobId,undefined,undefined,{actorId:newId(),allowUncertainDispatch:true})).status).toBe('skipped');
  const r=await retryFailedAiJob(env,f.jobId,undefined,undefined,{actorId:f.user.userId,allowUncertainDispatch:true});expect(r.status).toBe('queued');
  const original=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1').bind(f.jobId).first<{input_json:string}>();expect(JSON.parse(original!.input_json).allowUncertainCheckpointRetry).toBeUndefined();
});

it('manual uncertain dispatch authorization is consumed before the next paid request',async()=>{
  const f=await fixture();const params={projectId:f.projectId,jobId:f.jobId,purpose:'textEconomy' as const,configVersionId:f.config.id,model:f.config.config.textEconomy.model,modelConfig:f.config.config.textEconomy,promptVersion:'uncertain-consume',messages:[{role:'user' as const,content:'generate'}],schema:z.object({title:z.string()})};
  const fingerprint=await checkpointFingerprint({projectId:params.projectId,promptVersion:params.promptVersion,configVersionId:params.configVersionId,modelConfig:params.modelConfig,messages:params.messages});
  await saveResponseCheckpoint(env,`ai/responses/${f.jobId}/${fingerprint}/0/${f.jobId}.json.dispatch`,{pending:true});
  await expect(aiJsonCall(env,params)).rejects.toThrow('结果未确认');
  await env.DB.prepare("UPDATE jobs SET input_json=json_set(input_json,'$.allowUncertainCheckpointRetry',json('true')) WHERE id=?1").bind(f.jobId).run();
  const fetch=vi.fn(async()=>{expect(await allowsUncertainCheckpointRetry(env,f.jobId)).toBe(false);return Response.json({choices:[{message:{content:'{"title":"resumed"}'}}],usage:{prompt_tokens:10,completion_tokens:5}});});vi.stubGlobal('fetch',fetch);
  expect((await aiJsonCall(env,params)).data.title).toBe('resumed');expect(fetch).toHaveBeenCalledTimes(1);
});

it('received response blobs are immutable and successor investigation objects cannot be replaced by old attempt writes',async()=>{
  const f=await fixture(),key='ai/responses/immutable/'+newId();
  await saveResponseCheckpoint(env,key,{content:'first'});await saveResponseCheckpoint(env,key,{content:'late'});
  expect(await loadResponseCheckpoint(env,key)).toEqual({content:'first'});
  const id=f.jobId+'-isolated',state={step:3,exchanges:[],references:[],trace:[]};
  await saveInvestigation(env,{projectId:f.projectId,userId:f.user.userId,jobId:f.jobId},id,'isolated',state);
  const oldKey=`ai/investigations/${id}/${f.jobId}.json`,oldObject=await (await env.FILES.get(oldKey))!.text();
  await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?1").bind(f.jobId).run();
  const retry=await retryFailedAiJob(env,f.jobId);expect(retry.status).toBe('queued');
  expect((await loadInvestigation(env,id,false,retry.jobId))?.step).toBe(3);
  await saveInvestigation(env,{projectId:f.projectId,userId:f.user.userId,jobId:retry.jobId},id,'isolated',{...state,step:4});
  await env.FILES.put(oldKey,oldObject);
  expect((await loadInvestigation(env,id,false,retry.jobId))?.step).toBe(4);
  expect((await loadInvestigation(env,id))?.step).toBe(4);
});
