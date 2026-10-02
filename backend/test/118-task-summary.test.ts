import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import type { Env } from '../src/env';
import type { CollaborationTask } from '../src/services/collaboration';
import { enqueueTaskSummary, readTaskSummary, runTaskSummaryJob } from '../src/services/task-summary';
import { getJob } from '../src/services/jobs';
import { runAiJob } from '../src/services/ai-jobs';
await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
const offline = {...env,AGENT_WORKFLOW:{create:async()=>{throw new Error('offline fixture');}}} as unknown as Env;
async function fixture(detail='采集真实样本并记录来源与采集时间。'.repeat(5)) {
  await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();
  const user=await seedUser(), projectId=await seedProject(user.userId),taskId=crypto.randomUUID(),now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId),
    env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,criteria) VALUES(?1,?2,'采样',?3,'todo',1,?4,?5,?5,'提供来源')").bind(taskId,projectId,detail,user.userId,now),
  ]);
  const task=async()=> (await env.DB.prepare('SELECT * FROM tasks WHERE id=?1').bind(taskId).first<CollaborationTask>())!;
  return {user,projectId,taskId,task,start:(retry=false)=>enqueueTaskSummary(offline,projectId,taskId,user.userId,retry),read:async()=>readTaskSummary(env,await task())};
}
function model(summary='采集真实样本，记录来源及采集时间。',before?:()=>Promise<void>) {
  const fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    assertGoRequest(url,init); await before?.();
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({summary})}}],usage:{prompt_tokens:30,completion_tokens:20}}),{headers:{'content-type':'application/json'}});
  });
  vi.stubGlobal('fetch',fetch);return fetch;
}
describe('independent bounded task summaries',()=>{
  it('bypasses AI and jobs for short Unicode source including 60 astral characters',async()=>{
    const f=await fixture('😀'.repeat(60)),provider=model();
    expect(await f.start()).toMatchObject({summary:'😀'.repeat(60),summaryStatus:'ready'});
    expect(provider).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT 1 FROM task_summaries WHERE task_id=?1').bind(f.taskId).first()).toBeNull();
  });
  it('falls back to criteria when description is blank',async()=>{
    const f=await fixture('  ');expect(await f.start()).toMatchObject({summary:'提供来源',summaryStatus:'ready'});
  });
  it('atomically deduplicates racing requests and persists without task revision mutation',async()=>{
    const f=await fixture();const [a,b]=await Promise.all([f.start(),f.start()]);
    expect(a.summaryJobId).toBe(b.summaryJobId);
    const provider=model();await runAiJob(env,a.summaryJobId!);
    expect(await f.read()).toMatchObject({summaryStatus:'ready',summary:'采集真实样本，记录来源及采集时间。'});
    expect((await f.task()).revision).toBe(1);
    await f.start();await runTaskSummaryJob(env,a.summaryJobId!);expect(provider).toHaveBeenCalledTimes(1);
    const body=JSON.parse(String(provider.mock.calls[0]![1]?.body));expect(body.tools).toBeUndefined();
  });
  it('invalidates criteria changes but reuses summary for status changes',async()=>{
    const f=await fixture(),a=await f.start();model();await runTaskSummaryJob(env,a.summaryJobId!);
    await env.DB.prepare("UPDATE tasks SET status='doing',revision=revision+1 WHERE id=?1").bind(f.taskId).run();
    expect((await f.read()).summaryStatus).toBe('ready');
    await env.DB.prepare("UPDATE tasks SET criteria='提供采集日期' WHERE id=?1").bind(f.taskId).run();
    expect((await f.read()).summaryStatus).toBe('missing');expect((await f.start()).summaryJobId).not.toBe(a.summaryJobId);
  });
  it('rejects late source results and does not expose outdated cache',async()=>{
    const f=await fixture(),a=await f.start();
    model('采集真实样本。',async()=>{await env.DB.prepare('UPDATE tasks SET detail=?2 WHERE id=?1').bind(f.taskId,'新的任务说明'.repeat(20)).run();});
    await runTaskSummaryJob(env,a.summaryJobId!);expect((await getJob(env,a.summaryJobId!)).status).toBe('failed');expect((await f.read()).summaryStatus).toBe('missing');
  });
  it('enforces 60 character bound and retries failed calls only explicitly',async()=>{
    const f=await fixture(),a=await f.start(),provider=model('字'.repeat(61));
    await runTaskSummaryJob(env,a.summaryJobId!);expect((await f.read()).summaryStatus).toBe('failed');
    expect((await f.start()).summaryJobId).toBe(a.summaryJobId);expect(provider).toHaveBeenCalledTimes(2);
    const retry=await f.start(true);expect(retry.summaryJobId).not.toBe(a.summaryJobId);model();await runTaskSummaryJob(env,retry.summaryJobId!);expect((await f.read()).summaryStatus).toBe('ready');
  });
  it('honors project enablement and provider enablement without model calls',async()=>{
    const f=await fixture(),provider=model();await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();
    expect((await f.start()).summaryStatus).toBe('disabled');
    await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();expect((await f.start()).summaryStatus).toBe('disabled');expect(provider).not.toHaveBeenCalled();
  });
  it('honors membership when enqueueing and generating',async()=>{
    const f=await fixture(),outsider=await seedUser();
    await expect(enqueueTaskSummary(offline,f.projectId,f.taskId,outsider.userId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    const a=await f.start(),provider=model();await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1').bind(f.projectId).run();
    await runTaskSummaryJob(env,a.summaryJobId!);expect(provider).not.toHaveBeenCalled();expect((await getJob(env,a.summaryJobId!)).status).toBe('failed');
  });
  it('rejects exhausted budget and records failure without retry loops',async()=>{
    const f=await fixture(),provider=model();await env.DB.prepare('UPDATE projects SET ai_budget_usd=0 WHERE id=?1').bind(f.projectId).run();
    await expect(f.start()).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});expect((await f.read()).summaryStatus).toBe('failed');expect(provider).not.toHaveBeenCalled();
  });
  it('rejects configuration changes while a provider result is pending',async()=>{
    const f=await fixture(),a=await f.start();model('采集真实样本。',async()=>{await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();});
    await runTaskSummaryJob(env,a.summaryJobId!);expect((await getJob(env,a.summaryJobId!)).status).toBe('failed');
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();expect((await f.read()).summaryStatus).toBe('failed');
  });
  it('records provider failures and releases or reconciles reservation',async()=>{
    const f=await fixture(),a=await f.start();vi.stubGlobal('fetch',vi.fn(async()=>new Response('provider unavailable',{status:503})));
    await runTaskSummaryJob(env,a.summaryJobId!);expect((await f.read()).summaryStatus).toBe('failed');
    const reservation=await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(a.summaryJobId).first<{status:string}>();expect(reservation!.status).not.toBe('reserved');
  });
  it('recovers abandoned cache claims only on explicit retry',async()=>{
    const f=await fixture(),missing=await f.read(),jobId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO task_summaries(project_id,task_id,source_hash,status,job_id,updated_at) VALUES(?1,?2,?3,'queued',?4,?5)").bind(f.projectId,f.taskId,missing.summarySourceHash,jobId,new Date(Date.now()-600_000).toISOString()).run();
    expect((await f.start()).summaryStatus).toBe('failed');expect((await f.start(true)).summaryJobId).not.toBe(jobId);
  });
  it('exposes schema through authenticated list and denies outsiders POST',async()=>{
    const f=await fixture('简短任务'),outsider=await seedUser();
    const list=await SELF.fetch(BASE+`/api/v1/projects/${f.projectId}/collaboration/tasks`,{headers:{cookie:authCookie(f.user.token)}});
    expect(list.status).toBe(200);const json=await list.json() as {data:{items:Array<{summary:string}>}};expect(json.data.items[0]!.summary).toBe('简短任务');
    const normalList=await SELF.fetch(BASE+`/api/v1/projects/${f.projectId}/tasks`,{headers:{cookie:authCookie(f.user.token)}});
    expect(normalList.status).toBe(200); const normalJson=await normalList.json() as {data:{items:Array<{summary:string}>}};expect(normalJson.data.items[0]!.summary).toBe('简短任务');
    const normalDetail=await SELF.fetch(BASE+`/api/v1/projects/${f.projectId}/tasks/${f.taskId}`,{headers:{cookie:authCookie(f.user.token)}});
    expect(await normalDetail.json()).toMatchObject({data:{summary:'简短任务',summaryStatus:'ready'}});
    const response=await SELF.fetch(BASE+`/api/v1/projects/${f.projectId}/collaboration/tasks/${f.taskId}/summary`,{method:'POST',headers:{cookie:authCookie(outsider.token),'content-type':'application/json'},body:'{}'});expect(response.status).toBe(403);
  });
});
