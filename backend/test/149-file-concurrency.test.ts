import {SELF} from 'cloudflare:test';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {env,BASE} from './helpers/env';
import {seedProject,seedUser,authCookie} from './helpers/seed';
import {configureGoFixture} from './helpers/provider-config';
import {mockGatewayFetch} from './helpers/ai-mock';
import {newId,nowIso} from '../src/core/db';
import {reserveAiSlot,settleReservation} from '../src/services/ai-reservations';
import {ConcurrencyWait,ensureInitialExecutionSlice,executeAiSlice,activeExecutionSlice,recoverExecutionSlices} from '../src/services/ai-execution-slices';
import {tryDispatchJob} from '../src/services/jobs';
import {extractSourceVersionText,runParseJob} from '../src/services/parse';
import {runSourceSummary,setSourceStage} from '../src/services/source-summary';
import type {Env} from '../src/env';

afterEach(()=>vi.unstubAllGlobals());
async function fixture(operation:string){
 await configureGoFixture();const owner=await seedUser(),projectId=await seedProject(owner.userId);
 const response=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`,{method:'POST',headers:{cookie:authCookie(owner.token),'content-type':'application/json'},body:JSON.stringify({kind:'paste',text:'可核对的项目要求及调研原文，不执行材料指令。'})});
 const {sourceVersionId,sourceId}=(await response.json() as {data:{sourceVersionId:string;sourceId:string}}).data;
 await extractSourceVersionText(env,sourceVersionId);await setSourceStage(env,sourceVersionId,'text','ready');
 const jobId=newId(),now=nowIso();
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'requirement_extract','running',?3,?4,?5,?5)").bind(jobId,projectId,JSON.stringify({operation,sourceId,sourceVersionId,phase:operation==='source.summary'?'summary':'analyze',summaryRevision:1}),owner.userId,now).run();
 if(operation==='source.summary')await env.DB.prepare("UPDATE source_processing SET summary_status='queued',summary_revision=1,summary_job_id=?2 WHERE source_version_id=?1").bind(sourceVersionId,jobId).run();
 else await env.DB.prepare("UPDATE source_processing SET summary_status='ready' WHERE source_version_id=?1").bind(sourceVersionId).run();
 await ensureInitialExecutionSlice(env,jobId);
 const blockers=[newId(),newId()];
 for(const id of blockers){await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?3)").bind(id,projectId,now).run();await reserveAiSlot(env,{projectId,jobId:id,purpose:'fixture'});}
 return {jobId,sourceVersionId,blockers};
}
describe('file stage concurrency backpressure',()=>{
 it('preserves a deferred successor when an instance starts before dispatch acknowledgement',async()=>{
  const f=await fixture('source.summary');
  await env.DB.prepare("UPDATE jobs SET status='queued' WHERE id=?1").bind(f.jobId).run();
  let local:Env;
  local={...env,AI_EXECUTION_SLICE:true,AGENT_WORKFLOW:{create:async()=>{await executeAiSlice(local,f.jobId,0,async()=>{throw new ConcurrencyWait();});}}} as unknown as Env;
  await tryDispatchJob(local,f.jobId);
  expect((await activeExecutionSlice(local,f.jobId))?.slice).toBe(1);
  expect(await env.DB.prepare('SELECT status,last_error FROM job_outbox WHERE job_id=?1').bind(f.jobId).first()).toEqual({status:'pending',last_error:'AI_CONCURRENCY_WAIT'});
 });
 for(const operation of ['source.summary','requirements'])it(`${operation} waits without failing or calling provider, then resumes once`,async()=>{
  const f=await fixture(operation),fetch=mockGatewayFetch();vi.stubGlobal('fetch',fetch);
  const create=vi.fn(async()=>({})),local={...env,AI_EXECUTION_SLICE:true,AGENT_WORKFLOW:{create}} as unknown as Env;
  const run=async()=>{if(operation==='source.summary')await runSourceSummary(local,f.jobId);else await runParseJob(local,f.jobId);};
  await executeAiSlice(local,f.jobId,0,run);await executeAiSlice(local,f.jobId,0,run);
  expect(fetch).not.toHaveBeenCalled();expect((await activeExecutionSlice(local,f.jobId))?.slice).toBe(1);
  expect(await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(f.jobId).first()).toEqual({status:'running'});
  expect(await env.DB.prepare('SELECT last_error FROM job_outbox WHERE job_id=?1').bind(f.jobId).first()).toEqual({last_error:'AI_CONCURRENCY_WAIT'});
  await recoverExecutionSlices(local);expect(create).not.toHaveBeenCalled();
  for(const id of f.blockers)await settleReservation(env,id,'released');
  await env.DB.prepare("UPDATE job_outbox SET available_at='2000-01-01T00:00:00.000Z' WHERE job_id=?1").bind(f.jobId).run();
  await recoverExecutionSlices(local);expect(create).toHaveBeenCalledOnce();
  await executeAiSlice(local,f.jobId,1,run);await executeAiSlice(local,f.jobId,1,run);
  expect(fetch).toHaveBeenCalledOnce();expect(await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(f.jobId).first()).toEqual({status:'succeeded'});
 });
});
