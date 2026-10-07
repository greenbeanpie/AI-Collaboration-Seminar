import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { quotaExceeded } from '../src/core/errors';
import { cancelExecution,ensureExecution } from '../src/services/ai-execution-control';
import { failJob, succeedJob, waitJobInput } from '../src/services/jobs';
import { isConcurrencyLimitError, releaseIdleReservation, releaseStaleReservations, reserveAiSlot } from '../src/services/ai-reservations';

async function fixture(status = 'running', input: Record<string,unknown> = {}) {
  const user = await seedUser(), projectId = await seedProject(user.userId), jobId = newId(), now = nowIso();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run',?3,?4,?5,?5)")
    .bind(jobId,projectId,status,JSON.stringify(input),now).run();
  await reserveAiSlot(env,{projectId,jobId,purpose:'agent_run'});
  return {jobId,projectId,now};
}
const status = async (jobId:string) => (await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1 ORDER BY created_at DESC LIMIT 1').bind(jobId).first<{status:string}>())?.status;

describe('safe idle concurrency reservation release', () => {
  it('releases explicit cancellation immediately while rejecting an obsolete generation',async()=>{
    const f=await fixture(),execution=await ensureExecution(env,{kind:'job',id:f.jobId});
    await expect(cancelExecution(env,{kind:'job',id:f.jobId},execution.generation+1)).rejects.toThrow();
    expect(await status(f.jobId)).toBe('reserved');
    await cancelExecution(env,{kind:'job',id:f.jobId},execution.generation);
    expect(await status(f.jobId)).toBe('released');
  });
  it('releases recently terminal records on the next minute sweep', async () => {
    for (const state of ['failed','succeeded','cancelled']) {
      const f = await fixture(state);
      await releaseStaleReservations(env,nowIso());
      expect(await status(f.jobId)).toBe('released');
    }
  });
  it('releases success, failure and waiting-input transitions immediately', async () => {
    const success=await fixture(); await succeedJob(env,success.jobId,{}); expect(await status(success.jobId)).toBe('released');
    const failed=await fixture(); expect(await failJob(env,failed.jobId,{code:'INTERNAL',message:'done'})).toBe(true); expect(await status(failed.jobId)).toBe('released');
    const waiting=await fixture(); await waitJobInput(env,waiting.jobId,{needsImages:true}); expect(await status(waiting.jobId)).toBe('released');
  });
  it('does not release on a failed compare-and-swap transition', async () => {
    const f=await fixture();
    expect(await failJob(env,f.jobId,{code:'INTERNAL',message:'stale'},'old')).toBe(false);
    expect(await status(f.jobId)).toBe('reserved');
  });
  it('releases safe pauses but protects running jobs indefinitely', async () => {
    const paused=await fixture(), running=await fixture();
    await ensureExecution(env,{kind:'job',id:paused.jobId});
    await env.DB.prepare("UPDATE ai_executions SET state='paused',pause_reason='round_limit' WHERE target_id=?1").bind(paused.jobId).run();
    await releaseStaleReservations(env,new Date(Date.now()+4*3600_000).toISOString());
    expect(await status(paused.jobId)).toBe('released'); expect(await status(running.jobId)).toBe('reserved');
  });
  it('protects live and uncertain requests despite waiting-input or terminal jobs', async () => {
    for (const jobState of ['waiting_input','failed']) {
      for (const uncertain of [false,true]) {
        const f=await fixture(jobState); await ensureExecution(env,{kind:'job',id:f.jobId});
        await env.DB.prepare("UPDATE ai_executions SET state=?2,pause_reason=?3,inflight_token=?4 WHERE target_id=?1")
          .bind(f.jobId,uncertain?'paused':'running',uncertain?'request_uncertain':null,uncertain?null:'request-inflight').run();
        await releaseStaleReservations(env,new Date(Date.now()+4*3600_000).toISOString());
        expect(await status(f.jobId)).toBe('reserved');
      }
    }
  });
  it('follows retry roots when checking live execution protection', async () => {
    const root=await fixture(), retryId=newId(); await ensureExecution(env,{kind:'job',id:root.jobId});
    await env.DB.prepare("UPDATE ai_executions SET inflight_token='live' WHERE target_id=?1").bind(root.jobId).run();
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','waiting_input',?3,?4,?4)")
      .bind(retryId,root.projectId,JSON.stringify({autoRetryRootId:`job:${root.jobId}`}),root.now).run();
    await reserveAiSlot(env,{projectId:root.projectId,jobId:retryId,purpose:'agent_run'});
    await releaseIdleReservation(env,retryId);
    expect(await status(retryId)).toBe('reserved');
  });
  it('preserves orphan creation grace but reclaims abandoned uncreated jobs', async () => {
    const user=await seedUser(), projectId=await seedProject(user.userId), jobId=newId();
    await reserveAiSlot(env,{projectId,jobId,purpose:'agent_run'});
    await releaseStaleReservations(env,nowIso()); expect(await status(jobId)).toBe('reserved');
    await releaseStaleReservations(env,new Date(Date.now()+121_000).toISOString()); expect(await status(jobId)).toBe('released');
  });
  it('reclaimed slots retain usage and allow admission within the limit of two', async () => {
    const f=await fixture('waiting_input');
    await env.DB.prepare('UPDATE usage_reservations SET attempts_started=3 WHERE job_id=?1').bind(f.jobId).run();
    await releaseIdleReservation(env,f.jobId); await releaseIdleReservation(env,f.jobId);
    expect(await env.DB.prepare('SELECT status,attempts_started FROM usage_reservations WHERE job_id=?1').bind(f.jobId).first()).toMatchObject({status:'settled',attempts_started:3});
    await reserveAiSlot(env,{projectId:f.projectId,jobId:newId(),purpose:'agent_run'});
    await reserveAiSlot(env,{projectId:f.projectId,jobId:newId(),purpose:'agent_run'});
    await expect(reserveAiSlot(env,{projectId:f.projectId,jobId:newId(),purpose:'agent_run'})).rejects.toThrow('并发');
  });
  it('classifies only the project concurrency quota', () => {
    expect(isConcurrencyLimitError(quotaExceeded('full',{limit:2}))).toBe(true);
    expect(isConcurrencyLimitError(quotaExceeded('budget',{budget:2}))).toBe(false);
    expect(isConcurrencyLimitError(new Error('并发已达上限'))).toBe(false);
  });
});
