import { expect, it, vi, afterEach } from 'vitest';
import { env } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { recordActivity, recordModelResponse, readActivity, readActivityEvents, markModelDispatch } from '../src/services/ai-activity';
import { failJob } from '../src/services/jobs';
import { gatewayChat } from '../src/ai/gateway';
import { loadAiConfig } from '../src/ai/config';
import { configureGoFixture } from './helpers/provider-config';
import { SELF } from 'cloudflare:test';
import { BASE } from './helpers/env';
afterEach(()=>vi.unstubAllGlobals());
async function job(userId?:string){
 const user=userId?{userId}:await seedUser(),projectId=await seedProject(user.userId),id=newId(),now=nowIso();
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?4,?4)").bind(id,projectId,user.userId,now).run();return {id,projectId,user};
}
it('records true stages and paginates immutable history; scheduler updates do not change reply time',async()=>{
 const f=await job();expect((await readActivity(env,f.id,'running')).lastResponseAt).toBeNull();
 await recordActivity(env,f.id,'reading_sources','started',{completed:3,total:5,unit:'chunk'});await markModelDispatch(env,f.id);expect((await readActivity(env,f.id,'running')).uncertain).toBe(true);
 await recordModelResponse(env,f.id);const at=(await readActivity(env,f.id,'running')).lastResponseAt;expect(at).not.toBeNull();
 await env.DB.prepare('UPDATE jobs SET updated_at=?2 WHERE id=?1').bind(f.id,'2099-01-01T00:00:00Z').run();expect((await readActivity(env,f.id,'running')).lastResponseAt).toBe(at);
 const page=await readActivityEvents(env,f.id,0,2);expect(page.items).toHaveLength(2);expect(page.nextCursor).not.toBeNull();const next=await readActivityEvents(env,f.id,page.nextCursor!,2);expect(next.items.every(item=>item.id>page.nextCursor!)).toBe(true);
 expect(next.items).not.toEqual(expect.arrayContaining([expect.objectContaining({input:expect.anything()})]));
});
it('keeps reply time and completed records across a retry but blocks stale attempt progress',async()=>{
 const f=await job();await recordModelResponse(env,f.id);const at=(await readActivity(env,f.id,'running')).lastResponseAt;
 await env.DB.prepare("UPDATE jobs SET status='failed',updated_at=?2 WHERE id=?1").bind(f.id,nowIso()).run();const next=newId(),now=nowIso();
 await env.DB.batch([env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','queued','{}',?3,?4,?4)").bind(next,f.projectId,f.user.userId,now),env.DB.prepare('INSERT INTO admin_ai_retry_links VALUES(?1,?2,?3)').bind(f.id,next,now)]);
 await recordActivity(env,next,'retrying','resumed');await recordModelResponse(env,f.id);expect((await readActivity(env,next,'queued')).lastResponseAt).toBe(at);
 const events=await readActivityEvents(env,next);expect(events.items.some(e=>e.state==='failed')).toBe(true);expect(events.items.some(e=>e.state==='resumed')).toBe(true);
 await env.DB.prepare("UPDATE jobs SET status='succeeded',updated_at=?2 WHERE id=?1").bind(next,nowIso()).run();expect((await readActivity(env,next,'succeeded')).code).toBe('completed');
});
it('captures intermediate model replies and does not update on transport failure',async()=>{
 await configureGoFixture();const f=await job(),config=(await loadAiConfig(env.DB))!;
 const endpoint={accountId:'test',apiToken:'test',gatewayId:'test',envName:'local',authSecret:'test-auth-secret',diagnostics:env};
 const input={projectId:f.projectId,jobId:f.id,sessionId:f.id,config:config.config.textEconomy,messages:[{role:'user' as const,content:'x'}]};
 await gatewayChat(endpoint,input,async()=>Response.json({choices:[{message:{content:'first'}}]}));const at=(await readActivity(env,f.id,'running')).lastResponseAt;expect(at).not.toBeNull();
 await expect(gatewayChat(endpoint,input,async()=>{throw new Error('network');})).rejects.toThrow();expect((await readActivity(env,f.id,'running')).lastResponseAt).toBe(at);expect((await readActivity(env,f.id,'failed')).uncertain).toBe(true);
});
it('private draft job activity is unavailable to a different signed-in user',async()=>{
 const owner=await seedUser(),other=await seedUser(),id=newId(),now=nowIso();
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,NULL,'agent_run','failed','{}',?2,?3,?3)").bind(id,owner.userId,now).run();
 for(const suffix of ['','/activity-events']){
  const r=await SELF.fetch(BASE+'/api/v1/jobs/'+id+suffix,{headers:{Cookie:authCookie(other.token)}});expect(r.status).toBe(403);
 }
});

it('uncertain paid requests wait for a manual resume instead of an automatic replay',async()=>{
 const f=await job();await markModelDispatch(env,f.id);await failJob(env,f.id,{code:'AI_UNAVAILABLE',message:'请求结果未知'});
 expect(await env.DB.prepare('SELECT 1 FROM ai_automatic_retries WHERE target_id=?1').bind(f.id).first()).toBeNull();
 expect((await readActivity(env,f.id,'failed')).uncertain).toBe(true);
});

it('loads latest events first, pages older history and catches up newer events',async()=>{
 const user=await seedUser(),f=await job(user.userId);
 for(let i=0;i<5;i++)await recordActivity(env,f.id,'reading_sources','started',{completed:i});
 const newest=await readActivityEvents(env,f.id,0,2,'desc');
 expect(newest.items.map(e=>e.progress?.completed)).toEqual([4,3]);
 const older=await readActivityEvents(env,f.id,newest.nextCursor!,2,'desc');
 expect(older.items.map(e=>e.progress?.completed)).toEqual([2,1]);
 await recordActivity(env,f.id,'repairing');
 const fresh=await readActivityEvents(env,f.id,newest.items[0]!.id,20);
 expect(fresh.items).toHaveLength(1);expect(fresh.items[0]!.code).toBe('repairing');
 const response=await SELF.fetch(BASE+'/api/v1/jobs/'+f.id+'/activity-events?order=desc&limit=2',{headers:{Cookie:authCookie(user.token)}});
 expect(response.status).toBe(200);
 const body=await response.json() as {data:{items:Array<{id:number}>}};
 expect(body.data.items[0]!.id).toBe(fresh.items[0]!.id);
});

it('counts tool attempts explicitly and does not inherit the count in read or model events',async()=>{
 const f=await job();
 await recordActivity(env,f.id,'executing_tool','failed',{completed:4,unit:'tool_call'});
 expect((await readActivity(env,f.id,'running')).progress).toEqual({completed:4,unit:'tool_call'});
 await recordActivity(env,f.id,'reading_sources');
 expect((await readActivity(env,f.id,'running')).progress).toBeNull();
 await markModelDispatch(env,f.id);
 const events=await readActivityEvents(env,f.id);
 expect(events.items.find(e=>e.code==='executing_tool')?.progress).toEqual({completed:4,unit:'tool_call'});
 expect(events.items.filter(e=>e.code!=='executing_tool').every(e=>e.progress===null)).toBe(true);
 // An old persisted tool stage remains readable, but its inherited count is cleared.
 await recordActivity(env,f.id,'executing_tool','completed',{completed:5,unit:'step'});
 await markModelDispatch(env,f.id);
 expect((await readActivity(env,f.id,'running')).progress).toBeNull();
 const old=await readActivityEvents(env,f.id);
 expect(old.items.find(e=>e.code==='executing_tool'&&e.progress?.completed===5)?.progress?.unit).toBe('step');
});
