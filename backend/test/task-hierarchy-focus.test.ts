import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { focusTasks } from '../src/services/task-hierarchy';
import { applyProposal } from '../src/services/collaboration';
import { profileStamp } from '../src/services/personal-profiles';

async function fixture(){
 const owner=await seedUser(),member=await seedUser(),projectId=await seedProject(owner.userId);
 await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),projectId,member.userId,nowIso()).run();
 const req=async(path:string,method='GET',body?:unknown,asMember=false)=>{const response=await SELF.fetch(`${BASE}/api/v1/projects/${projectId}${path}`,{method,headers:{cookie:authCookie((asMember?member:owner).token),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json() as {data:any;error:any}};};
 const create=async(title:string,extra:Record<string,unknown>={})=>(await req('/tasks','POST',{title,criteria:'可以验证',...extra})).data;
 const graph=async()=>(await req('/tasks/graph')).data;
 return {owner,member,projectId,req,create,graph};
}
describe('task hierarchy and personal focus',()=>{
 it('maintains source provenance when moving and clearing parent, and preserves independent lifecycle',async()=>{
  const {create,req,graph}=await fixture();const a=await create('父 A'),b=await create('父 B');
  const child=await create('子任务',{parentTaskId:a.taskId,expectedGraphRevision:(await graph()).graphRevision});
  let g=await graph();expect(g.items.find((t:any)=>t.taskId===a.taskId)).toMatchObject({dependsOnTaskIds:[child.taskId],manualDependsOnTaskIds:[],status:'todo'});
  expect((await req(`/tasks/${a.taskId}/dependencies`,'PUT',{expectedGraphRevision:g.graphRevision,dependsOnTaskIds:[child.taskId]})).status).toBe(200);
  g=await graph();expect((await req(`/tasks/${child.taskId}/parent`,'PUT',{expectedGraphRevision:g.graphRevision,parentTaskId:b.taskId})).status).toBe(200);
  g=await graph();expect(g.items.find((t:any)=>t.taskId===a.taskId).manualDependsOnTaskIds).toEqual([child.taskId]);expect(g.items.find((t:any)=>t.taskId===b.taskId).dependsOnTaskIds).toEqual([child.taskId]);
  expect((await req(`/tasks/${child.taskId}/parent`,'PUT',{expectedGraphRevision:g.graphRevision,parentTaskId:null})).status).toBe(200);
  g=await graph();expect(g.items.find((t:any)=>t.taskId===b.taskId).dependsOnTaskIds).toEqual([]);expect(g.items.find((t:any)=>t.taskId===a.taskId).dependsOnTaskIds).toEqual([child.taskId]);
 });
 it('rejects mixed-edge cycles, self-parent, invalid parent, stale revision and unauthorized changes atomically',async()=>{
  const {create,req,graph}=await fixture();const a=await create('A'),b=await create('B');let g=await graph();
  expect((await req(`/tasks/${b.taskId}/parent`,'PUT',{parentTaskId:a.taskId,expectedGraphRevision:g.graphRevision})).status).toBe(200);g=await graph();
  for(const parent of [a.taskId,b.taskId,newId()])expect((await req(`/tasks/${a.taskId}/parent`,'PUT',{parentTaskId:parent,expectedGraphRevision:g.graphRevision})).status).toBe(400);
  expect((await req(`/tasks/${b.taskId}/dependencies`,'PUT',{dependsOnTaskIds:[a.taskId],expectedGraphRevision:g.graphRevision})).status).toBe(400);
  expect((await req(`/tasks/${b.taskId}/parent`,'PUT',{parentTaskId:null,expectedGraphRevision:g.graphRevision-1})).status).toBe(409);
  expect((await req(`/tasks/${b.taskId}/parent`,'PUT',{parentTaskId:null,expectedGraphRevision:g.graphRevision},true)).status).toBe(403);
  expect((await graph()).graphRevision).toBe(g.graphRevision);
 });
 it('supports multiple levels, rejects archived/cross-project parents and arbitrates concurrent moves',async()=>{
  const {create,req,graph,owner}=await fixture();const a=await create('根'),b=await create('中',{parentTaskId:a.taskId,expectedGraphRevision:(await graph()).graphRevision}),c=await create('叶',{parentTaskId:b.taskId,expectedGraphRevision:(await graph()).graphRevision});
  const otherProject=await seedProject(owner.userId),foreign=newId();await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at) VALUES(?1,?2,'外部','','todo',1,?3,?4,?4)").bind(foreign,otherProject,owner.userId,nowIso()).run();
  const archived=await create('归档');await env.DB.prepare('UPDATE tasks SET archived_at=?2 WHERE id=?1').bind(archived.taskId,nowIso()).run();
  const g=await graph();for(const parent of [foreign,archived.taskId])expect((await req(`/tasks/${c.taskId}/parent`,'PUT',{parentTaskId:parent,expectedGraphRevision:g.graphRevision})).status).toBe(400);
  const changes=await Promise.all([req(`/tasks/${c.taskId}/parent`,'PUT',{parentTaskId:a.taskId,expectedGraphRevision:g.graphRevision}),req(`/tasks/${c.taskId}/parent`,'PUT',{parentTaskId:null,expectedGraphRevision:g.graphRevision})]);expect(changes.map(r=>r.status).sort()).toEqual([200,409]);
  const after=await graph();expect(after.graphRevision).toBe(g.graphRevision+1);expect(after.items.find((t:any)=>t.taskId===b.taskId).dependsOnTaskIds).toEqual([]);
 });
 it('pins are personal, focus uses complete project data and review permission is project-scoped',async()=>{
  const {create,req,owner,member,projectId}=await fixture();const own=await create('执行',{assigneeId:owner.userId}),other=await create('别人',{assigneeId:member.userId});
  expect((await req(`/tasks/${other.taskId}/pin`,'PUT',{pinned:true})).status).toBe(200);
  const focus=(await req('/tasks/focus')).data;expect(focus.items.map((t:any)=>t.taskId)).toEqual([other.taskId,own.taskId]);expect(focus.items[0].focusReasons).toContain('我关注');
  expect((await req('/tasks/focus','GET',undefined,true)).data.items[0].pinned).toBe(false);
  await env.DB.prepare("UPDATE tasks SET lifecycle_state='submitted' WHERE id=?1").bind(own.taskId).run();
  expect((await req('/tasks/focus')).data.waitingReview).toHaveLength(1);expect((await req('/tasks/focus')).data.reviewRequired).toHaveLength(1);expect((await req('/tasks/focus','GET',undefined,true)).data.reviewRequired).toEqual([]);
  await env.DB.prepare("UPDATE tasks SET status='done',lifecycle_state='accepted' WHERE id=?1 AND project_id=?2").bind(other.taskId,projectId).run();expect((await req('/tasks/focus')).data.items).toEqual([]);
 });
 it('AI reparenting preserves a matching manual edge; regeneration archives history without leaking old pins',async()=>{
  const {owner,projectId,create,req,graph}=await fixture();
  const a=await create('旧父'),b=await create('新父'),child=await create('子',{parentTaskId:a.taskId,expectedGraphRevision:(await graph()).graphRevision});
  await req(`/tasks/${a.taskId}/dependencies`,'PUT',{dependsOnTaskIds:[child.taskId],expectedGraphRevision:(await graph()).graphRevision});
  const proposal=async(payload:unknown)=>{const jobId=newId(),id=newId();await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded',?3,0,?4,?4)").bind(jobId,projectId,JSON.stringify({profileStamp:await profileStamp(env,projectId)}),nowIso()).run();await env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,created_at,updated_at) VALUES(?1,?2,'decompose',?3,?4,1,?5,?5)").bind(id,projectId,jobId,JSON.stringify(payload),nowIso()).run();return id;};
  const update=await proposal({updates:[{taskId:child.taskId,parentTaskId:b.taskId,expectedRevision:child.revision,title:child.title,detail:child.detail,criteria:child.criteria,effortHours:child.effortHours}]});
  await applyProposal(env,projectId,update,1,owner.userId);let g=await graph();
  expect(g.items.find((t:any)=>t.taskId===a.taskId).manualDependsOnTaskIds).toEqual([child.taskId]);expect(g.items.find((t:any)=>t.taskId===b.taskId).dependsOnTaskIds).toEqual([child.taskId]);
  const collision=await proposal({tasks:[{key:a.taskId,parent:b.taskId,title:'冲突标识',detail:'',criteria:'x',effortHours:1}]});await expect(applyProposal(env,projectId,collision,1,owner.userId)).rejects.toThrow('覆盖已有任务');
  await req(`/tasks/${child.taskId}/pin`,'PUT',{pinned:true});
  const replacement=await proposal({planningAction:'regenerate',tasks:[{key:'new',title:'新计划',detail:'',criteria:'x',effortHours:1}]});await applyProposal(env,projectId,replacement,1,owner.userId);g=await graph();expect(g.items).toHaveLength(1);expect(g.items[0].parentTaskId).toBeNull();expect((await req('/tasks/focus')).data.items).toEqual([]);
  const historical=await env.DB.prepare('SELECT parent_task_id,archived_at FROM tasks WHERE id=?1').bind(child.taskId).first<{parent_task_id:string;archived_at:string}>();expect(historical?.parent_task_id).toBe(b.taskId);expect(historical?.archived_at).toBeTruthy();
  expect((await env.DB.prepare('SELECT manual_origin,hierarchy_origin FROM task_dependencies WHERE task_id=?1 AND depends_on_task_id=?2').bind(a.taskId,child.taskId).first())).toEqual({manual_origin:1,hierarchy_origin:0});
 });
 it('applies AI parent references after all new tasks exist and rejects selected orphan references',async()=>{
  const {owner,projectId,graph}=await fixture();const jobId=newId(),proposalId=newId();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded',?3,0,?4,?4)").bind(jobId,projectId,JSON.stringify({profileStamp:await profileStamp(env,projectId)}),nowIso()).run();
  await env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,created_at,updated_at) VALUES(?1,?2,'decompose',?3,?4,1,?5,?5)").bind(proposalId,projectId,jobId,JSON.stringify({tasks:[{key:'child',parent:'parent',title:'子',detail:'',criteria:'x',effortHours:1},{key:'parent',title:'父',detail:'',criteria:'x',effortHours:1}]}),nowIso()).run();
  await expect(applyProposal(env,projectId,proposalId,1,owner.userId,false,undefined,{selectedTaskKeys:['child']})).rejects.toThrow();
  await applyProposal(env,projectId,proposalId,1,owner.userId);const g=await graph(),child=g.items.find((t:any)=>t.title==='子'),parent=g.items.find((t:any)=>t.title==='父');expect(child.parentTaskId).toBe(parent.taskId);expect(parent.dependsOnTaskIds).toEqual([child.taskId]);expect(parent.manualDependsOnTaskIds).toEqual([]);
 });
});
it('focus ordering handles date, datetime, pinned, rework and downstream tie breaks deterministically',()=>{
 const make=(taskId:string,dueDate:string|null,lifecycleState='in_progress')=>({taskId,dueDate,lifecycleState,assigneeId:'me',status:'doing',dependsOnTaskIds:[] as string[]});
 const tasks=[make('later',null),make('soon','2026-10-31'),make('rework',null,'rework'),make('overdue','2026-10-28'),{...make('time','2026-10-29T01:00:00Z'),duePrecision:'datetime'},make('pin',null)];
 expect(focusTasks(tasks,'me',new Set(['pin']),false,new Date('2026-10-29T02:00:00Z')).items.map(t=>t.taskId)).toEqual(['pin','overdue','time','rework','soon','later']);
});
