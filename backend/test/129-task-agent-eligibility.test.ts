import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import type { Env } from '../src/env';
import { enqueueTaskAgentEligibility, readTaskAgentEligibility } from '../src/services/task-agent-eligibility';
import { getJob } from '../src/services/jobs';
import { runAiJob } from '../src/services/ai-jobs';
await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
const offline = {...env,AGENT_WORKFLOW:{create:async()=>{throw new Error('offline fixture');}}} as unknown as Env;
async function fixture(detail='整理已提供的现场访谈资料并分析主要观点') {
  await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();
  const user=await seedUser(), projectId=await seedProject(user.userId),taskId=crypto.randomUUID(),now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId),
    env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,criteria) VALUES(?1,?2,'资料分析',?3,'todo',1,?4,?5,?5,'提供分析报告')").bind(taskId,projectId,detail,user.userId,now),
  ]);
  return {user,projectId,taskId,start:(retry=false)=>enqueueTaskAgentEligibility(offline,projectId,taskId,user.userId,1,retry),read:()=>readTaskAgentEligibility(env,projectId,taskId,user.userId)};
}
function model(output:unknown={eligible:true,reason:'可基于已有访谈资料进行数字分析'},before?:()=>Promise<void>) {
  const fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    assertGoRequest(url,init); await before?.();
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:30,completion_tokens:20}}),{headers:{'content-type':'application/json'}});
  });
  vi.stubGlobal('fetch',fetch);return fetch;
}
describe('model based task Agent eligibility',()=>{
  it('GET never calls a model; short tasks are assessed by the model with complete inputs and no tools',async()=>{
    const f=await fixture('分析'),provider=model();expect(await f.read()).toMatchObject({status:'missing',eligible:null,jobId:null,taskRevision:1});expect(provider).not.toHaveBeenCalled();
    const a=await f.start();await runAiJob(env,a.jobId!);
    expect(await f.read()).toMatchObject({status:'ready',eligible:true,reason:'可基于已有访谈资料进行数字分析'});
    const body=JSON.parse(String(provider.mock.calls[0]![1]?.body));expect(body.tools).toBeUndefined();expect(JSON.parse(body.messages[1].content)).toEqual({title:'资料分析',detail:'分析',criteria:'提供分析报告'});
    expect(body.messages[0].content).toContain('不采用关键词匹配');
    await f.start();await runAiJob(env,a.jobId!);expect(provider).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(f.taskId).first()).toMatchObject({revision:1});
    expect(await env.DB.prepare('SELECT prompt_version FROM ai_calls WHERE job_id=?1').bind(a.jobId).first()).toMatchObject({prompt_version:'task-agent-eligibility-v1'});
  });
  it.each(['现场访谈并撰写报告','分析资料，随后到现场取样','完成调研'])('persists a model denial without local keyword overrides: %s',async detail=>{
    const f=await fixture(detail),a=await f.start();model({eligible:false,reason:'任务需要现场工作或缺少必要前提，无法独立完成'});await runAiJob(env,a.jobId!);expect(await f.read()).toMatchObject({status:'ready',eligible:false});
  });
  it('atomically deduplicates concurrent requests before budgeting',async()=>{
    const f=await fixture(),[a,b]=await Promise.all([f.start(),f.start()]);expect(a.jobId).toBe(b.jobId);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_reservations WHERE project_id=?1').bind(f.projectId).first()).toMatchObject({n:1});
  });
  it('requires explicit retry after invalid output; reserves and audits both bounded repair calls',async()=>{
    const f=await fixture(),a=await f.start(),provider=model({eligible:'yes',reason:''});await runAiJob(env,a.jobId!);
    expect(await f.read()).toMatchObject({status:'failed',eligible:null});expect(provider).toHaveBeenCalledTimes(2);expect((await f.start()).jobId).toBe(a.jobId);
    const retry=await f.start(true);expect(retry.jobId).not.toBe(a.jobId);model();await runAiJob(env,retry.jobId!);expect((await f.read()).status).toBe('ready');
  });
  it('repairs one invalid model output and succeeds',async()=>{
    const f=await fixture(),a=await f.start();let n=0;model({eligible:true,reason:'可以完成'},async()=>{n++;if(n===1)throw new Error('provider transport failure');});
    // A transport failure is terminal rather than an unsafe replay.
    await runAiJob(env,a.jobId!);expect((await f.read()).status).toBe('failed');
    const b=await f.start(true);const provider=model();provider.mockImplementationOnce(async()=>new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:30,completion_tokens:20}}),{headers:{'content-type':'application/json'}}));
    await runAiJob(env,b.jobId!);expect(provider).toHaveBeenCalledTimes(2);expect((await f.read()).status).toBe('ready');
  });
  it.each(['title','detail','criteria'])('invalidates %s edits and rejects in flight results',async column=>{
    const f=await fixture(),a=await f.start();model(undefined,async()=>{await env.DB.prepare(`UPDATE tasks SET ${column}='新内容' WHERE id=?1`).bind(f.taskId).run();});
    await runAiJob(env,a.jobId!);expect((await getJob(env,a.jobId!)).status).toBe('failed');expect((await f.read()).status).toBe('missing');
  });
  it('invalidates config versions and guards both disabled project and global config even when ready',async()=>{
    const f=await fixture(),a=await f.start();model();await runAiJob(env,a.jobId!);
    await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();expect(await f.read()).toMatchObject({status:'disabled',eligible:null});
    await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();expect((await f.read()).status).toBe('disabled');
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();
    await env.DB.prepare("INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at,created_by) SELECT ?1,MAX(version)+1,config_json,1,created_at,created_by FROM ai_config_versions").bind(crypto.randomUUID()).run();expect((await f.read()).status).toBe('missing');
  });
  it.each(['member','config','archived'])('rejects stale %s permissions/state after model call',async change=>{
    const f=await fixture(),a=await f.start();model(undefined,async()=>{
      if(change==='member')await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();
      if(change==='config')await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();
      if(change==='archived')await env.DB.prepare('UPDATE tasks SET archived_at=?2 WHERE id=?1').bind(f.taskId,new Date().toISOString()).run();
    });await runAiJob(env,a.jobId!);expect((await getJob(env,a.jobId!)).status).toBe('failed');
    expect(await env.DB.prepare('SELECT status FROM task_agent_eligibility WHERE job_id=?1').bind(a.jobId).first()).toMatchObject({status:'failed'});
  });
  it('checks membership before calls and expected revision before budgeting',async()=>{
    const f=await fixture(),a=await f.start(),provider=model();await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();await runAiJob(env,a.jobId!);expect(provider).not.toHaveBeenCalled();
    const other=await fixture();await expect(enqueueTaskAgentEligibility(offline,other.projectId,other.taskId,other.user.userId,2)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    await expect(readTaskAgentEligibility(env,other.projectId,f.taskId,other.user.userId)).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('records budget exhaustion without paid calls',async()=>{
    const f=await fixture(),provider=model();await env.DB.prepare('UPDATE projects SET ai_budget_usd=0 WHERE id=?1').bind(f.projectId).run();await expect(f.start()).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});expect((await f.read()).status).toBe('failed');expect(provider).not.toHaveBeenCalled();
  });
  it('allows ordinary members to request a read-only check without management permissions',async()=>{
    const f=await fixture(),member=await seedUser();
    await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(crypto.randomUUID(),f.projectId,member.userId,new Date().toISOString()).run();
    const a=await enqueueTaskAgentEligibility(offline,f.projectId,f.taskId,member.userId,1);model();await runAiJob(env,a.jobId!);
    expect(await readTaskAgentEligibility(env,f.projectId,f.taskId,member.userId)).toMatchObject({status:'ready',eligible:true});
  });
  it('hides cached eligibility and does not enqueue while disabled',async()=>{
    const f=await fixture(),a=await f.start(),provider=model();await runAiJob(env,a.jobId!);
    await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();
    expect(await f.start()).toMatchObject({status:'disabled',eligible:null,reason:null,jobId:null});expect(provider).toHaveBeenCalledTimes(1);
  });
  it('does not present incomplete ready rows as a negative model verdict',async()=>{
    const f=await fixture(),a=await f.start();model();await runAiJob(env,a.jobId!);
    await env.DB.prepare('UPDATE task_agent_eligibility SET eligible=NULL,reason=NULL WHERE job_id=?1').bind(a.jobId).run();
    expect(await f.read()).toMatchObject({status:'failed',eligible:null,reason:null});expect((await f.start(true)).jobId).not.toBe(a.jobId);
  });
  it('rejects a new config before the first provider call',async()=>{
    const f=await fixture(),a=await f.start(),provider=model();
    await env.DB.prepare("INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at,created_by) SELECT ?1,MAX(version)+1,config_json,1,created_at,created_by FROM ai_config_versions").bind(crypto.randomUUID()).run();
    await runAiJob(env,a.jobId!);expect(provider).not.toHaveBeenCalled();expect((await getJob(env,a.jobId!)).status).toBe('failed');
  });
  it('atomically rejects task edits between final read and result UPDATE',async()=>{
    const f=await fixture(),a=await f.start();model();
    const guarded = {...env,DB:{prepare:(sql:string)=>{
      const statement=env.DB.prepare(sql);
      if(!sql.startsWith('UPDATE task_agent_eligibility SET eligible='))return statement;
      return {bind:(...args:unknown[])=>({run:async()=>{
        await env.DB.prepare("UPDATE tasks SET title='已变化' WHERE id=?1").bind(f.taskId).run();
        return statement.bind(...args).run();
      }})};
    }}} as unknown as Env;
    await runAiJob(guarded,a.jobId!);expect((await getJob(env,a.jobId!)).status).toBe('failed');expect((await f.read()).status).toBe('missing');
  });
  it('recovers terminal and abandoned jobs on explicit retry',async()=>{
    const f=await fixture(),a=await f.start();await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id=?1").bind(a.jobId).run();expect((await f.start()).status).toBe('failed');expect((await f.start(true)).jobId).not.toBe(a.jobId);
    const other=await fixture(),missing=await other.read(),jobId=crypto.randomUUID();await env.DB.prepare("INSERT INTO task_agent_eligibility(project_id,task_id,source_hash,status,job_id,updated_at) VALUES(?1,?2,?3,'queued',?4,?5)").bind(other.projectId,other.taskId,missing.sourceHash,jobId,new Date(Date.now()-600_000).toISOString()).run();expect((await other.start()).status).toBe('failed');expect((await other.start(true)).jobId).not.toBe(jobId);
  });
  it('authenticates read and POST; validates strict revision input',async()=>{
    const f=await fixture(),outsider=await seedUser(),url=BASE+`/api/v1/projects/${f.projectId}/collaboration/tasks/${f.taskId}/agent-eligibility`;
    expect((await SELF.fetch(url,{headers:{cookie:authCookie(outsider.token)}})).status).toBe(403);
    expect((await SELF.fetch(url,{headers:{cookie:authCookie(f.user.token)}})).status).toBe(200);
    for(const body of [{},{expectedRevision:0},{expectedRevision:1,eligible:true}])expect((await SELF.fetch(url,{method:'POST',headers:{cookie:authCookie(f.user.token),'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(400);
    expect((await SELF.fetch(url,{method:'POST',headers:{cookie:authCookie(f.user.token),'content-type':'application/json'},body:JSON.stringify({expectedRevision:2})})).status).toBe(409);
    expect((await SELF.fetch(url,{method:'POST',headers:{cookie:authCookie(f.user.token),'content-type':'application/json'},body:JSON.stringify({expectedRevision:1})})).status).toBe(200);
  });
});
