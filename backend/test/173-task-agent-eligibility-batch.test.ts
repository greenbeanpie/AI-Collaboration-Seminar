import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { configureGoFixture } from './helpers/provider-config';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { readTaskAgentEligibility, readTaskAgentEligibilityBatch } from '../src/services/task-agent-eligibility';
await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());

async function fixture(count=1) {
  await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();
  const user=await seedUser(),projectId=await seedProject(user.userId),taskIds=Array.from({length:count},()=>crypto.randomUUID()),now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId),
    ...taskIds.map(taskId=>env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,criteria) VALUES(?1,?2,'资料分析','分析资料','todo',1,?3,?4,?4,'报告')").bind(taskId,projectId,user.userId,now)),
  ]);
  return {user,projectId,taskIds,read:()=>readTaskAgentEligibilityBatch(env,projectId,taskIds,user.userId)};
}

describe('batch task Agent eligibility reads',()=>{
  it('matches all single-task states without enqueuing or invoking providers',async()=>{
    const f=await fixture(6),initial=await f.read(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    for (const [index,item] of initial.items.entries()) {
      if(index===0)continue;
      const status=index===1?'queued':index===2?'running':index===3?'ready':index===4?'ready':'queued';
      await env.DB.prepare('INSERT INTO task_agent_eligibility(project_id,task_id,source_hash,status,job_id,eligible,reason,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(f.projectId,item.taskId,item.eligibility!.sourceHash,status,crypto.randomUUID(),index===3?1:null,index===3?'数字任务':null,new Date(Date.now()-(index===5?600_000:0)).toISOString()).run();
    }
    const batch=await f.read();
    expect(batch.items.map(item=>item.eligibility!.status)).toEqual(['missing','queued','running','ready','failed','failed']);
    for(const item of batch.items)expect(item.eligibility).toEqual(await readTaskAgentEligibility(env,f.projectId,item.taskId,f.user.userId));
    expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id=?1').bind(f.projectId).first()).toMatchObject({n:0});
  });
  it('uses current task revision, activation epoch and latest config, hiding disabled verdicts',async()=>{
    const f=await fixture(),taskId=f.taskIds[0]!,first=(await f.read()).items[0]!.eligibility!;
    await env.DB.prepare("INSERT INTO task_agent_eligibility(project_id,task_id,source_hash,status,job_id,eligible,reason,updated_at) VALUES(?1,?2,?3,'ready',?4,1,'数字任务',?5)").bind(f.projectId,taskId,first.sourceHash,crypto.randomUUID(),new Date().toISOString()).run();
    expect((await f.read()).items[0]!.eligibility!.status).toBe('ready');
    await env.DB.prepare("UPDATE tasks SET title='新标题',revision=2 WHERE id=?1").bind(taskId).run();
    const edited=(await f.read()).items[0]!.eligibility!;expect(edited).toMatchObject({status:'missing',taskRevision:2});expect(edited.sourceHash).not.toBe(first.sourceHash);
    await env.DB.prepare('UPDATE task_agent_auto_checks SET activation_epoch=activation_epoch+1 WHERE task_id=?1').bind(taskId).run();
    const activated=(await f.read()).items[0]!.eligibility!;expect(activated.sourceHash).not.toBe(edited.sourceHash);
    await env.DB.prepare('INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at,created_by) SELECT ?1,MAX(version)+1,config_json,1,created_at,created_by FROM ai_config_versions').bind(crypto.randomUUID()).run();
    const configured=(await f.read()).items[0]!.eligibility!;expect(configured.sourceHash).not.toBe(activated.sourceHash);
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();expect((await f.read()).items[0]!.eligibility).toMatchObject({status:'disabled',eligible:null,reason:null,jobId:null});
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();expect((await f.read()).items[0]!.eligibility!.status).toBe('disabled');
  });
  it('returns NOT_FOUND per foreign, missing and archived task while preserving request order',async()=>{
    const f=await fixture(2),foreign=await fixture(),missing=crypto.randomUUID();
    await env.DB.prepare('UPDATE tasks SET archived_at=?2 WHERE id=?1').bind(f.taskIds[1],new Date().toISOString()).run();
    const ids=[foreign.taskIds[0]!,f.taskIds[0]!,missing,f.taskIds[1]!];
    const result=await readTaskAgentEligibilityBatch(env,f.projectId,ids,f.user.userId);
    expect(result.items.map(item=>item.taskId)).toEqual(ids);
    expect(result.items.filter(item=>item.taskId!==f.taskIds[0]).every(item=>item.eligibility===null&&item.errorCode==='NOT_FOUND')).toBe(true);
    expect(result.items[1]!.eligibility!.status).toBe('missing');
  });
  it('checks standalone and API membership on every request, including revocation',async()=>{
    const f=await fixture(),outsider=await seedUser(),url=BASE+`/api/v1/projects/${f.projectId}/collaboration/agent-eligibility?taskIds=${f.taskIds.join(',')}`;
    expect((await SELF.fetch(url)).status).toBe(401);
    expect((await SELF.fetch(url,{headers:{cookie:authCookie(outsider.token)}})).status).toBe(403);
    await expect(readTaskAgentEligibilityBatch(env,f.projectId,f.taskIds,outsider.userId)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    const response=await SELF.fetch(url,{headers:{cookie:authCookie(f.user.token)}});expect(response.status).toBe(200);expect((await response.json() as {data:unknown}).data).toEqual(await f.read());
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId,f.user.userId).run();
    expect((await SELF.fetch(url,{headers:{cookie:authCookie(f.user.token)}})).status).toBe(403);
    await expect(f.read()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('validates nonempty UUID batches, rejects duplicates and caps batches at 25',async()=>{
    const f=await fixture(),url=BASE+`/api/v1/projects/${f.projectId}/collaboration/agent-eligibility`,headers={cookie:authCookie(f.user.token)};
    for(const ids of ['', 'bad',`${f.taskIds[0]},${f.taskIds[0]}`,`${f.taskIds[0]},${f.taskIds[0]!.toUpperCase()}`,Array.from({length:26},()=>crypto.randomUUID()).join(',')]) {
      expect((await SELF.fetch(url+`?taskIds=${ids}`,{headers})).status).toBe(400);
    }
    expect((await SELF.fetch(url,{headers})).status).toBe(400);
    expect((await SELF.fetch(url+`?taskIds=${Array.from({length:25},()=>crypto.randomUUID()).join(',')}`,{headers})).status).toBe(200);
  });
  it('reads shared data in a constant five statements rather than six per task',async()=>{
    const f=await fixture(20),queries:string[]=[],metrics={rowsRead:0,rowsWritten:0,durationMs:0};
    const wrap=(statement:ReturnType<typeof env.DB.prepare>):ReturnType<typeof env.DB.prepare>=>new Proxy(statement,{
      get(target,property){
        if(property==='bind')return (...values:unknown[])=>wrap(target.bind(...values));
        if(property==='first'||property==='all')return async()=>{
          const result=await target.all();
          metrics.rowsRead+=result.meta.rows_read;metrics.rowsWritten+=result.meta.rows_written;metrics.durationMs+=result.meta.duration;
          return property==='first'?result.results[0]??null:result;
        };
        return Reflect.get(target,property,target);
      },
    });
    const measured={...env,DB:new Proxy(env.DB,{get(target,property){
      if(property==='prepare')return (sql:string)=>{queries.push(sql);return wrap(target.prepare(sql));};
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    }})};
    for(const taskId of f.taskIds)await readTaskAgentEligibility(measured,f.projectId,taskId,f.user.userId);
    expect(queries).toHaveLength(120);const single={queries:queries.length,...metrics};queries.length=0;metrics.rowsRead=0;metrics.rowsWritten=0;metrics.durationMs=0;
    await readTaskAgentEligibilityBatch(measured,f.projectId,f.taskIds,f.user.userId);expect(queries).toHaveLength(5);
    const batch={queries:queries.length,...metrics};
    console.log('eligibility D1 benchmark',JSON.stringify({taskCount:20,single,batch}));
    expect(batch.rowsWritten).toBe(0);expect(single.rowsWritten).toBe(0);expect(batch.rowsRead).toBeLessThan(single.rowsRead);
    const twenty=queries.slice();queries.length=0;
    await readTaskAgentEligibilityBatch(measured,f.projectId,[f.taskIds[0]!],f.user.userId);expect(queries).toHaveLength(5);
    expect(twenty.filter(sql=>sql.includes('ai_config_versions'))).toHaveLength(1);
    expect(twenty.filter(sql=>sql.includes('FROM tasks t'))).toHaveLength(1);
    expect(twenty.filter(sql=>sql.includes('WITH inputs'))).toHaveLength(1);
  });
});
