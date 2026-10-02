import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { newId, nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/budget';
import { projectToolConversation } from '../src/services/project-ai-tools';
import { activeExecutionSlice, ensureInitialExecutionSlice, dispatchExecutionSlice, executeAiSlice, recoverExecutionSlices } from '../src/services/ai-execution-slices';
import { getJob, reconcileWorkflowJob, succeedJob } from '../src/services/jobs';
import { InvestigationContinuation } from '../src/services/project-investigation';
afterEach(()=>vi.unstubAllGlobals());
async function fixture(){
  const owner=await seedUser(),projectId=await seedProject(owner.userId),jobId=newId();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?3)").bind(jobId,projectId,nowIso()).run();
  await ensureInitialExecutionSlice(env,jobId);
  return {owner,projectId,jobId};
}
function withWorkflow(create:unknown,get:unknown=()=>({status:async()=>({status:'running'})})):Env{
 return {...env,AGENT_WORKFLOW:{create,get} as unknown as Workflow};
}
describe('independent workflow instance relay',()=>{
 it('processes >16 slices in independent deterministic instances with two paid responses and no repeated reads',async()=>{
  await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;
  await reserveAiSlot(env,{projectId:f.projectId,jobId:f.jobId,purpose:'review_run',maxCalls:24});
  const fetch=vi.fn(async()=>Response.json({choices:[{finish_reason:fetch.mock.calls.length===1?'tool_calls':'stop',message:fetch.mock.calls.length===1?{tool_calls:Array.from({length:64},(_,i)=>({id:`read-${i}`,type:'function',function:{name:'list_project_resources',arguments:JSON.stringify({offset:i*20})}}))}:{content:'{"summary":"完成","referenceIds":[],"decisionReferences":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}}));
  vi.stubGlobal('fetch',fetch);
  const queue:{id:string;params:{jobId:string;slice:number}}[]=[];
  const create=vi.fn(async(input)=>{queue.push(input);return {};});const local=withWorkflow(create);
  await dispatchExecutionSlice(local,(await activeExecutionSlice(local,f.jobId))!);
  let executions=0;
  while(queue.length){
   const instance=queue.shift()!;instance.params.slice ??= 0;executions++;
   expect(instance.id).toBe(instance.params.slice===0?f.jobId:`${f.jobId}-s${instance.params.slice}`);
   const run=vi.fn(async()=>{await projectToolConversation({...local,AI_EXECUTION_SLICE:true},{context:{projectId:f.projectId,userId:f.owner.userId,jobId:f.jobId},config:config.config.review,configVersionId:config.id,purpose:'review',privateContext:true,messages:[{role:'user',content:'自主调查'}],promptVersion:'independent-slice-fixture'});await succeedJob(local,f.jobId,{ok:true});});
   await executeAiSlice(local,f.jobId,instance.params.slice,run);
   await executeAiSlice(local,f.jobId,instance.params.slice,run);
   expect(run).toHaveBeenCalledTimes(1);
  }
  expect(executions).toBeGreaterThan(16);expect(create).toHaveBeenCalledTimes(executions);expect(fetch).toHaveBeenCalledTimes(2);
  expect((await getJob(local,f.jobId)).status).toBe('succeeded');
  expect((await env.DB.prepare('SELECT COUNT(*) count FROM ai_tool_calls WHERE job_id=?1').bind(f.jobId).first<{count:number}>())!.count).toBe(64);
 }, 20_000);
 it('persists failed child delivery and cron retries same instance without rerunning parent',async()=>{
  const f=await fixture();const create=vi.fn().mockRejectedValueOnce(new Error('engine unavailable')).mockResolvedValue({});const local=withWorkflow(create);
  const run=vi.fn(async()=>{throw new InvestigationContinuation();});
  await executeAiSlice(local,f.jobId,0,run);
  expect((await activeExecutionSlice(local,f.jobId))?.status).toBe('pending');
  await recoverExecutionSlices(local);
  expect(create.mock.calls.map(call=>call[0].id)).toEqual([`${f.jobId}-s1`,`${f.jobId}-s1`]);
  await executeAiSlice(local,f.jobId,0,run);expect(run).toHaveBeenCalledTimes(1);
 });
 it('reconciles active child instead of completed root',async()=>{
  const f=await fixture(),local=withWorkflow(vi.fn(async()=>({})));
  await executeAiSlice(local,f.jobId,0,async()=>{throw new InvestigationContinuation();});
  const get=vi.fn(async(id:string)=>({status:async()=>({status:id===f.jobId?'complete':'running'})}));
  await reconcileWorkflowJob(withWorkflow(vi.fn(),get),f.jobId);
  expect(get).toHaveBeenCalledWith(`${f.jobId}-s1`);expect((await getJob(local,f.jobId)).status).toBe('running');
 });
 it('fails terminal active child but preserves concurrent business success',async()=>{
  const f=await fixture();await env.DB.prepare("UPDATE ai_execution_slices SET status='dispatched' WHERE job_id=?1").bind(f.jobId).run();
  await reconcileWorkflowJob(withWorkflow(vi.fn(),()=>({status:async()=>({status:'errored'})})),f.jobId);
  expect((await getJob(env,f.jobId)).status).toBe('failed');
  const second=await fixture();await env.DB.prepare("UPDATE ai_execution_slices SET status='dispatched' WHERE job_id=?1").bind(second.jobId).run();
  await reconcileWorkflowJob(withWorkflow(vi.fn(),()=>({status:async()=>{await succeedJob(env,second.jobId,{late:true});return {status:'complete'};}})),second.jobId);
  expect((await getJob(env,second.jobId)).status).toBe('succeeded');
 });
 it('does not fail a successor inserted while checking the prior instance terminal state',async()=>{
  const f=await fixture(),local=withWorkflow(vi.fn(async()=>({})));
  await env.DB.prepare("UPDATE ai_execution_slices SET status='dispatched' WHERE job_id=?1").bind(f.jobId).run();
  await reconcileWorkflowJob(withWorkflow(vi.fn(),()=>({status:async()=>{
   await executeAiSlice(local,f.jobId,0,async()=>{throw new InvestigationContinuation();});
   return {status:'complete'};
  }})),f.jobId);
  expect((await activeExecutionSlice(env,f.jobId))?.slice).toBe(1);
  expect((await getJob(env,f.jobId)).status).toBe('running');
 });
 it('never recreates an uncertain missing instance once its slice started',async()=>{
  const f=await fixture();
  await env.DB.prepare("UPDATE ai_execution_slices SET status='running' WHERE job_id=?1").bind(f.jobId).run();
  const create=vi.fn();
  await reconcileWorkflowJob(withWorkflow(create,async()=>{throw new Error('instance.not_found');}),f.jobId);
  await recoverExecutionSlices(withWorkflow(create));
  expect(create).not.toHaveBeenCalled();expect((await getJob(env,f.jobId)).status).toBe('failed');
 });
});
