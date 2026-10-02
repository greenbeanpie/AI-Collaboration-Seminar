import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { memberPermissions, managerPermissions, projectPermissionSql } from '../src/services/project-permissions';
import { projectGoal, replaceTaskDependencies } from '../src/services/project-simplification';

async function fixture() {
  const owner=await seedUser(), member=await seedUser(), third=await seedUser(); const projectId=await seedProject(owner.userId);
  for (const user of [member,third]) await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),projectId,user.userId,nowIso()).run();
  const req=(token:string,path:string,method='GET',body?:unknown)=>SELF.fetch(`${BASE}/api/v1/projects/${projectId}${path}`,{method,headers:{cookie:authCookie(token),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {owner,member,third,projectId,req};
}
describe('project operation permissions',()=>{
  it('delegated dependency replacement evaluates the complete graph without transient readiness',async()=>{
    const f=await fixture(), a=newId(), b=newId(), down=newId();
    await f.req(f.owner.token,`/members/${f.member.userId}/permissions`,'PATCH',{expectedRevision:1,permissions:managerPermissions});
    for(const [id,status] of [[a,'todo'],[b,'done'],[down,'doing']])await env.DB.prepare('INSERT INTO tasks(id,project_id,title,status,assignee_id,created_by,created_at,updated_at) VALUES(?1,?2,?1,?3,?4,?5,?6,?6)').bind(id,f.projectId,status,f.third.userId,f.owner.userId,nowIso()).run();
    const replace=async(ids:string[])=>replaceTaskDependencies(env,f.projectId,f.member.userId,down,(await projectGoal(env,f.projectId)).graphRevision,ids);
    const count=async()=>(await env.DB.prepare("SELECT COUNT(*) n FROM notification_events WHERE resource_id=?1 AND kind='task_ready'").bind(f.projectId).first<{n:number}>())!.n;
    await replace([a]);expect(await count()).toBe(0);
    await replace([b]);expect(await count()).toBe(1);
    await replace([b]);expect(await count()).toBe(1);
    await replace([a,b]);expect(await count()).toBe(1);
    await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(a).run();expect(await count()).toBe(2);
  });
  it('member read contract is complete and invitations are inaccessible until explicitly delegated',async()=>{
    const f=await fixture();const r=await f.req(f.member.token,'/members');expect(r.status).toBe(200);
    const b=await r.json() as {data:{items:Array<{userId:string;permissions:unknown;permissionsRevision:number}>}};
    expect(b.data.items.find(m=>m.userId===f.member.userId)).toMatchObject({permissions:memberPermissions,permissionsRevision:1});
    expect((await f.req(f.member.token,'/invitations')).status).toBe(403);
    const grant=await f.req(f.owner.token,`/members/${f.member.userId}/permissions`,'PATCH',{expectedRevision:1,permissions:managerPermissions});expect(grant.status).toBe(200);
    expect((await f.req(f.member.token,'/invitations')).status).toBe(200);
    expect((await f.req(f.member.token,`/members/${f.third.userId}/permissions`,'PATCH',{expectedRevision:1,permissions:managerPermissions})).status).toBe(403);
    expect((await f.req(f.member.token,`/members/${f.owner.userId}`,'DELETE')).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE project_id=?1 AND type='member.permissions_changed'").bind(f.projectId).first<{n:number}>())?.n).toBe(1);
  });
  it('stale writes conflict; revocation and membership removal prevent transaction writes',async()=>{
    const f=await fixture();const path=`/members/${f.member.userId}/permissions`;
    expect((await f.req(f.owner.token,path,'PATCH',{expectedRevision:1,permissions:managerPermissions})).status).toBe(200);
    expect((await f.req(f.owner.token,path,'PATCH',{expectedRevision:1,permissions:memberPermissions})).status).toBe(409);
    expect((await f.req(f.owner.token,path,'PATCH',{expectedRevision:2,permissions:memberPermissions})).status).toBe(200);
    expect((await f.req(f.member.token,'/invitations','POST',{})).status).toBe(403);
    const check=()=>env.DB.prepare(`SELECT 1 allowed WHERE ${projectPermissionSql('?1','?2','taskManage')}`).bind(f.projectId,f.member.userId).first();
    expect(await check()).toBeNull();
    await env.DB.prepare("UPDATE auth_accounts SET account_role='admin' WHERE user_id=?1").bind(f.member.userId).run();expect(await check()).not.toBeNull();
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId,f.member.userId).run();expect(await check()).toBeNull();
  });
  it('project-member platform admins grant permissions, external admins cannot',async()=>{
    const f=await fixture();await env.DB.prepare("UPDATE auth_accounts SET account_role='admin' WHERE user_id=?1").bind(f.member.userId).run();
    expect((await f.req(f.member.token,`/members/${f.third.userId}/permissions`,'PATCH',{expectedRevision:1,permissions:managerPermissions})).status).toBe(200);
    const external=await seedUser();await env.DB.prepare("UPDATE auth_accounts SET account_role='admin' WHERE user_id=?1").bind(external.userId).run();
    expect((await f.req(external.token,`/members/${f.third.userId}/permissions`,'PATCH',{expectedRevision:2,permissions:memberPermissions})).status).toBe(403);
  });
  it('delegated task managers create/edit tasks and lose access immediately on revocation',async()=>{
    const f=await fixture();const body={title:'delegated task',detail:'test',criteria:'verified',effortHours:1};
    expect((await f.req(f.member.token,'/collaboration/tasks','POST',body)).status).toBe(403);
    await f.req(f.owner.token,`/members/${f.member.userId}/permissions`,'PATCH',{expectedRevision:1,permissions:managerPermissions});
    const res=await f.req(f.member.token,'/collaboration/tasks','POST',body);expect(res.status).toBe(201);
    const task=await res.json() as {data:{taskId:string;revision:number}};
    expect((await f.req(f.member.token,`/collaboration/tasks/${task.data.taskId}`,'PATCH',{expectedRevision:task.data.revision,title:'changed'})).status).toBe(200);
    await f.req(f.owner.token,`/members/${f.member.userId}/permissions`,'PATCH',{expectedRevision:2,permissions:memberPermissions});
    expect((await f.req(f.member.token,`/collaboration/tasks/${task.data.taskId}`,'PATCH',{expectedRevision:2,title:'forbidden'})).status).toBe(403);
  });
});
