import { describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { newId, nowIso } from '../src/core/db';
import { seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { creationPayload } from '../src/services/creation-drafts';
import { loadDraftCheckpoint, saveDraftCheckpoint } from '../src/services/draft-preview-checkpoints';
import { failJob } from '../src/services/jobs';
import { prepareAutomaticJobRetry, retryFailedDraftPreview, recoverAutomaticAiRetries, scheduleAutomaticJobRetry, isAutomaticAiFailure, AUTOMATIC_AI_RETRY_DELAY_MS } from '../src/services/ai-automatic-retries';

async function job(input:unknown={}) {
  const id=newId(),now=nowIso();
  await env.DB.prepare("INSERT INTO jobs(id,kind,status,input_json,created_at,updated_at) VALUES(?1,'agent_run','running',?2,?3,?3)").bind(id,JSON.stringify(input),now).run();
  return id;
}
async function due(id:string) {
  await env.DB.prepare("UPDATE ai_automatic_retries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(id).run();
}
async function retryRow(id:string) {
  return env.DB.prepare('SELECT * FROM ai_automatic_retries WHERE id=?1').bind(id).first<{attempts:number;status:string;next_attempt_at:string;target_id:string;lease_token:string|null}>();
}
const providerFailure={code:'AI_UNAVAILABLE',message:'网络请求超时；用量待核对'};

describe('durable 60-second AI recovery',()=>{
  it('queues network/timeout and invalid output failures, excluding lifecycle/permission/budget errors',async()=>{
    expect(isAutomaticAiFailure('AI_UNAVAILABLE')).toBe(true);
    expect(isAutomaticAiFailure('AI_OUTPUT_INVALID')).toBe(true);
    for(const code of ['QUOTA_EXCEEDED','PERMISSION_DENIED','INVALID_STATE','INTERNAL'])expect(isAutomaticAiFailure(code)).toBe(false);
    const id=await job(),before=Date.now();
    expect(await failJob(env,id,providerFailure)).toBe(true);
    const row=(await retryRow(`job:${id}`))!;
    expect(row.status).toBe('pending');expect(row.attempts).toBe(0);
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThanOrEqual(before+AUTOMATIC_AI_RETRY_DELAY_MS);
    const callback=vi.fn(async()=>({jobId:newId()}));
    await recoverAutomaticAiRetries(env,callback);
    expect(callback).not.toHaveBeenCalled();
    await scheduleAutomaticJobRetry(env,id,providerFailure);
    expect((await retryRow(`job:${id}`))?.next_attempt_at).toBe(row.next_attempt_at);
    const blocked=await job();await failJob(env,blocked,{code:'QUOTA_EXCEEDED',message:'预算不足'});
    expect(await retryRow(`job:${blocked}`)).toBeNull();
  });
  it('commits failure, outbox and retry intent atomically or rolls all three back',async()=>{
    const id=await job(),now=nowIso();
    await env.DB.prepare("INSERT INTO job_outbox(id,job_id,status,available_at,created_at,updated_at) VALUES(?1,?2,'pending',?3,?3,?3)").bind(newId(),id,now).run();
    await env.DB.exec("CREATE TRIGGER reject_automatic_retry BEFORE INSERT ON ai_automatic_retries BEGIN SELECT RAISE(ABORT,'retry queue unavailable'); END");
    try {
      await expect(failJob(env,id,providerFailure)).rejects.toThrow('retry queue unavailable');
      expect((await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(id).first<{status:string}>())?.status).toBe('running');
      expect((await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id=?1').bind(id).first<{status:string}>())?.status).toBe('pending');
      expect(await retryRow(`job:${id}`)).toBeNull();
    } finally { await env.DB.exec('DROP TRIGGER reject_automatic_retry'); }
    expect(await failJob(env,id,providerFailure)).toBe(true);
    expect((await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id=?1').bind(id).first<{status:string}>())?.status).toBe('failed');
    expect((await retryRow(`job:${id}`))?.status).toBe('pending');
  });
  it('cannot enqueue a stale or mismatched failure',async()=>{
    const id=await job();
    expect(await failJob(env,id,providerFailure,'2000-01-01T00:00:00.000Z')).toBe(false);
    expect(await retryRow(`job:${id}`)).toBeNull();
    await failJob(env,id,{code:'INVALID_STATE',message:'已取消'});
    const failedAt=(await env.DB.prepare('SELECT updated_at FROM jobs WHERE id=?1').bind(id).first<{updated_at:string}>())!.updated_at;
    await prepareAutomaticJobRetry(env,id,providerFailure,failedAt)!.run();
    expect(await retryRow(`job:${id}`)).toBeNull();
  });
  it('inherits the original chain across new jobs and stops after three failed recoveries',async()=>{
    let id=await job();const root=`job:${id}`;
    await failJob(env,id,providerFailure);
    const callback=vi.fn(async(_env:unknown,_parent:string,rootId:string)=>{
      const child=await job({autoRetryRootId:rootId});
      return {status:'retried',jobId:child};
    });
    for(let n=1;n<=3;n++) {
      await due(root);
      expect(await recoverAutomaticAiRetries(env,callback)).toBe(1);
      const row=(await retryRow(root))!;id=row.target_id;
      expect(row.attempts).toBe(n);expect(row.status).toBe('dispatched');
      await failJob(env,id,providerFailure);
      expect((await retryRow(root))?.status).toBe(n===3?'exhausted':'pending');
    }
    await due(root);expect(await recoverAutomaticAiRetries(env,callback)).toBe(0);
    expect(callback).toHaveBeenCalledTimes(3);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_automatic_retries WHERE id=?1').bind(root).first<{n:number}>())?.n).toBe(1);
  });
  it('claims concurrently once and cancels requests rejected by safety guards',async()=>{
    const id=await job(),root=`job:${id}`;await failJob(env,id,providerFailure);await due(root);
    const callback=vi.fn(async()=>({status:'skipped',reason:'来源已取消'}));
    await Promise.all([recoverAutomaticAiRetries(env,callback),recoverAutomaticAiRetries(env,callback)]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await retryRow(root))?.status).toBe('cancelled');
  });
  it('resumes an expired dispatch lease without incrementing the numbered attempt',async()=>{
    const id=await job(),root=`job:${id}`;await failJob(env,id,providerFailure);
    await env.DB.prepare("UPDATE ai_automatic_retries SET attempts=1,status='dispatching',lease_until='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(root).run();
    const callback=vi.fn(async()=>({jobId:id}));
    await recoverAutomaticAiRetries(env,callback);
    expect(callback).toHaveBeenCalledTimes(1);expect((await retryRow(root))?.attempts).toBe(1);
  });
  it('retains an already scheduled child failure if it arrives before dispatch bookkeeping',async()=>{
    const id=await job(),root=`job:${id}`;await failJob(env,id,providerFailure);await due(root);
    await recoverAutomaticAiRetries(env,async(_env,_parent,rootId)=>{
      const child=await job({autoRetryRootId:rootId});await failJob(env,child,providerFailure);return {jobId:child};
    });
    const row=(await retryRow(root))!;expect(row.status).toBe('pending');expect(row.attempts).toBe(1);expect(row.lease_token).toBeNull();
  });
  it('requires an explicit click before replaying an unknown draft provider request',async()=>{
    await configureGoFixture();const owner=await seedUser(),draftId=newId(),attempt=newId(),cfg=(await loadAiConfig(env.DB))!,now=nowIso(),payload=creationPayload.parse({name:'未知请求',aiCollaborationEnabled:true});
    await env.DB.prepare("INSERT INTO project_creation_drafts(id,owner_id,payload_json,preview_state,preview_attempt_id,preview_config_version_id,project_id,created_at,updated_at) VALUES(?1,?2,?3,'failed',?4,?5,?6,?7,?7)").bind(draftId,owner.userId,JSON.stringify(payload),attempt,cfg.id,newId(),now).run();
    await saveDraftCheckpoint(env,{version:1,draftId,userId:owner.userId,revision:1,attempt,configVersionId:cfg.id,payload,context:[],system:'fixture',step:2,exchanges:[],pendingDispatch:true});
    await env.DB.prepare("INSERT INTO ai_automatic_retries(id,target_kind,target_id,draft_id,status,next_attempt_at,created_at,updated_at) VALUES(?1,'draft_preview',?2,?3,'pending',?4,?4,?4)").bind('draft:'+attempt,attempt,draftId,now).run();
    const create=vi.fn(async()=>({})),testEnv={...env,AGENT_WORKFLOW:new Proxy(env.AGENT_WORKFLOW,{get:(target,key)=>key==='create'?create:Reflect.get(target,key)})};
    await recoverAutomaticAiRetries(testEnv,vi.fn());expect(create).not.toHaveBeenCalled();expect((await loadDraftCheckpoint(env,attempt))!.checkpoint.pendingDispatch).toBe(true);
    expect(await retryFailedDraftPreview(testEnv,draftId)).toMatchObject({status:'retried',jobId:attempt});expect(create).toHaveBeenCalledTimes(1);
  });
  it('retries an unknown draft dispatch while preserving paid output and completed tool results',async()=>{
    await configureGoFixture();const owner=await seedUser(),draftId=newId(),attempt=newId(),cfg=(await loadAiConfig(env.DB))!,now=nowIso();
    const payload=creationPayload.parse({name:'重试草稿',aiCollaborationEnabled:true});
    await env.DB.prepare("INSERT INTO project_creation_drafts(id,owner_id,payload_json,preview_state,preview_attempt_id,preview_config_version_id,project_id,created_at,updated_at) VALUES(?1,?2,?3,'failed',?4,?5,?6,?7,?7)").bind(draftId,owner.userId,JSON.stringify(payload),attempt,cfg.id,newId(),now).run();
    const output={content:'already paid output',promptTokens:2,completionTokens:1,latencyMs:1};
    const result={call:{id:'read-1',name:'read_draft_document',args:{}},output:{text:'已完成读取'}};
    await saveDraftCheckpoint(env,{version:1,draftId,userId:owner.userId,revision:1,attempt,configVersionId:cfg.id,payload,context:[],system:'fixture',step:2,exchanges:[],pendingDispatch:true,pendingOutput:output,pendingResults:[result]});
    const create=vi.fn(async()=>({}));const testEnv={...env,AGENT_WORKFLOW:new Proxy(env.AGENT_WORKFLOW,{get:(target,key)=>key==='create'?create:Reflect.get(target,key)})};
    expect(await retryFailedDraftPreview(testEnv,draftId)).toMatchObject({status:'retried',jobId:attempt});
    const restored=(await loadDraftCheckpoint(env,attempt))!.checkpoint;
    expect(restored.pendingDispatch).toBe(false);expect(restored.pendingOutput).toEqual(output);expect(restored.pendingResults).toEqual([result]);expect(restored.step).toBe(2);
    expect(create).toHaveBeenCalledTimes(1);expect(create.mock.calls[0]).toMatchObject([{id:`${attempt}-retry-1`}]);
    await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='failed' WHERE id=?1").bind(draftId).run();
    await env.DB.prepare("UPDATE ai_automatic_retries SET status='exhausted',attempts=3 WHERE id=?1").bind(`draft:${attempt}`).run();
    const restarted=await retryFailedDraftPreview(testEnv,draftId);
    expect(restarted.status).toBe('retried');expect(restarted.jobId).toBe(attempt);
    expect((await loadDraftCheckpoint(env,attempt))!.checkpoint.pendingResults).toEqual([result]);
    expect((await retryRow(`draft:${attempt}`))?.status).toBe('exhausted');
  });

});
