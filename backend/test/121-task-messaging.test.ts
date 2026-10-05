import { SELF } from 'cloudflare:test';
import { describe,it,expect } from 'vitest';
import { env,BASE } from './helpers/env';
import { seedUser,seedProject,authCookie,type SeededUser } from './helpers/seed';
import { newId,nowIso } from '../src/core/db';
import { readinessStatements } from '../src/services/task-readiness';
async function fixture(){
 const owner=await seedUser(),a=await seedUser(),b=await seedUser(),project=await seedProject(owner.userId);
 for(const u of [a,b])await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),project,u.userId,nowIso()).run();
 const task=async(user:SeededUser,status='doing')=>{const id=newId();await env.DB.prepare('INSERT INTO tasks(id,project_id,title,assignee_id,status,created_by,created_at,updated_at) VALUES(?1,?2,?1,?3,?4,?3,?5,?5)').bind(id,project,user.userId,status,nowIso()).run();return id;};
 const edge=async(down:string,up:string)=>{await env.DB.prepare('INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)').bind(project,down,up,nowIso()).run();await env.DB.batch(readinessStatements(env,project));};
 const call=async(u:SeededUser,path:string,method='GET',body?:unknown,key?:string)=>{const r=await SELF.fetch(`${BASE}/api/v1/projects/${project}${path}`,{method,headers:{cookie:authCookie(u.token),'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json() as any};};
 return {owner,a,b,project,task,edge,call};
}
describe('task messaging',()=>{
 it('lets any member open a private one-to-one ticket for the selected task and another member',async()=>{
  const f=await fixture(),target=await f.task(f.owner,'done'),senderTask=await f.task(f.b,'doing'),outsider=await seedUser();
  const made=await f.call(f.b,`/tasks/${target}/inquiries`,'POST',{recipientId:f.a.userId,body:'请说明任务要求'},'ticket-key');expect(made.status).toBe(201);
  const id=made.json.data.inquiryId;
  expect((await f.call(f.b,`/tasks/${target}/inquiries`,'POST',{recipientId:f.a.userId,body:'请说明任务要求'},'ticket-key')).json.data.inquiryId).toBe(id);
  expect((await f.call(f.a,`/tasks/${target}/inquiries`)).json.data.items[0]).toMatchObject({taskId:target,upstreamTaskId:target,recipientSource:'direct',requesterId:f.b.userId,recipientId:f.a.userId});
  expect((await f.call(f.b,`/tasks/${target}/inquiries`)).json.data.items).toHaveLength(1);
  expect((await f.call(f.owner,`/tasks/${target}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.a,`/tasks/${senderTask}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.b,`/tasks/${senderTask}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.b,`/tasks/${target}/inquiries`,'POST',{recipientId:f.b.userId,body:'自问'})).status).toBe(409);
  expect((await f.call(f.b,`/tasks/${target}/inquiries`,'POST',{recipientId:outsider.userId,body:'外部成员'})).status).toBe(404);
  const firstMessage=(await env.DB.prepare('SELECT id FROM task_inquiry_messages WHERE inquiry_id=?1').bind(id).first<{id:string}>())!;
  const messageNotice=await env.DB.prepare('SELECT url FROM notification_events WHERE event_key=?1').bind(`task_inquiry:${firstMessage.id}`).first<{url:string}>();
  expect(messageNotice!.url).toBe(`/app/projects/${f.project}/tasks?task=${target}&taskAction=inquiries`);
 });
 it('continues showing pre-existing two-task inquiries on each historical participant side',async()=>{
  const f=await fixture(),requesterTask=await f.task(f.b),recipientTask=await f.task(f.a),id=newId(),messageId=newId(),now=nowIso();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO task_inquiries(id,project_id,task_id,upstream_task_id,requester_id,recipient_id,recipient_source,task_title,upstream_title,created_at) VALUES(?1,?2,?3,?4,?5,?6,'completion','发起任务','接收任务',?7)").bind(id,f.project,requesterTask,recipientTask,f.b.userId,f.a.userId,now),
   env.DB.prepare("INSERT INTO task_inquiry_messages(id,inquiry_id,author_id,body,created_at) VALUES(?1,?2,?3,'历史质询',?4)").bind(messageId,id,f.b.userId,now),
  ]);
  expect((await f.call(f.b,`/tasks/${requesterTask}/inquiries`)).json.data.items[0]).toMatchObject({taskId:requesterTask,upstreamTaskId:recipientTask,recipientSource:'completion'});
  expect((await f.call(f.a,`/tasks/${recipientTask}/inquiries`)).json.data.items[0].messages[0].body).toBe('历史质询');
  expect((await f.call(f.b,`/tasks/${recipientTask}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.a,`/tasks/${requesterTask}/inquiries`)).json.data.items).toHaveLength(0);
 });
 it('notifies only on the last dependency, deduplicates and resets after reopen',async()=>{
  const f=await fixture(),x=await f.task(f.a),y=await f.task(f.a),down=await f.task(f.b);
  await f.edge(down,x);await f.edge(down,y);
  const count=async()=>Number((await env.DB.prepare("SELECT COUNT(*) n FROM notification_events WHERE resource_id=?1 AND kind='task_ready'").bind(f.project).first<{n:number}>())!.n);
  await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(x).run();expect(await count()).toBe(0);
  await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(y).run();expect(await count()).toBe(1);
  await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(y).run();expect(await count()).toBe(1);
  await env.DB.prepare("UPDATE tasks SET status='doing' WHERE id=?1").bind(y).run();await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(y).run();expect(await count()).toBe(2);
  expect((await env.DB.prepare('SELECT user_id FROM notification_inbox WHERE event_id IN(SELECT id FROM notification_events WHERE resource_id=?1)').bind(f.project).all<{user_id:string}>()).results.every(r=>r.user_id===f.b.userId)).toBe(true);
  const notice=(await env.DB.prepare("SELECT id FROM notification_events WHERE resource_id=?1 AND kind='task_ready' ORDER BY created_at DESC LIMIT 1").bind(f.project).first<{id:string}>())!;
  const read=await SELF.fetch(`${BASE}/api/v1/notifications/${notice.id}/read`,{method:'POST',headers:{cookie:authCookie(f.b.token),'content-type':'application/json'},body:'{}'});expect(read.status).toBe(200);
 });
 it('claiming ready work is silent, reassigning hides old recipient notifications',async()=>{
  const f=await fixture(),up=await f.task(f.a),down=await f.task(f.b);await f.edge(down,up);
  await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(up).run();await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(down,f.owner.userId).run();
  const r=await SELF.fetch(`${BASE}/api/v1/notifications`,{headers:{cookie:authCookie(f.b.token)}});expect((await r.json() as any).data.items).toHaveLength(0);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM notification_events WHERE resource_id=?1 AND kind='task_ready'").bind(f.project).first<{n:number}>())!.n).toBe(1);
  await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(down,f.b.userId).run();
  const back=await SELF.fetch(`${BASE}/api/v1/notifications`,{headers:{cookie:authCookie(f.b.token)}});expect((await back.json() as any).data.items).toHaveLength(0);
 });
 it('new assigned work and claim establish a silent baseline after graph creation',async()=>{
  const f=await fixture(),up=await f.task(f.a,'done'),down=await f.task(f.b);
  await env.DB.batch([env.DB.prepare('INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)').bind(f.project,down,up,nowIso()),...readinessStatements(env,f.project,[down])]);
  await env.DB.prepare('UPDATE tasks SET assignee_id=NULL WHERE id=?1').bind(down).run();await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(down,f.b.userId).run();
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM notification_events WHERE resource_id=?1 AND kind='task_ready'").bind(f.project).first<{n:number}>())!.n).toBe(0);
 });
 it('keeps participant-only replies and revokes ticket access when project membership ends',async()=>{
  const f=await fixture(),target=await f.task(f.owner,'done');
  const made=await f.call(f.b,`/tasks/${target}/inquiries`,'POST',{recipientId:f.a.userId,body:'接口格式影响我的实现'}),id=made.json.data.inquiryId;
  expect((await f.call(f.owner,`/task-inquiries/${id}/messages`,'POST',{body:'not participant'})).status).toBe(404);
  expect((await f.call(f.a,`/task-inquiries/${id}/messages`,'POST',{body:'使用 JSON'})).status).toBe(201);
  const thread=(await f.call(f.b,`/tasks/${target}/inquiries`)).json.data.items[0];expect(thread.recipientId).toBe(f.a.userId);expect(thread.recipientSource).toBe('direct');expect(thread.messages).toHaveLength(2);
  await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.project,f.a.userId).run();
  expect((await f.call(f.a,`/task-inquiries/${id}/messages`,'POST',{body:'gone'})).status).toBe(403);
  expect((await f.call(f.a,'/task-inquiries/unread')).status).toBe(403);
  expect((await f.call(f.a,`/tasks/${target}/inquiries/read`,'POST',{messageIds:[]})).status).toBe(403);
 });
 it('keeps each new ticket on the corresponding task and marks only displayed private messages read',async()=>{
  const f=await fixture(),target=await f.task(f.owner,'done'),requesterTask=await f.task(f.b,'doing');
  const made=await f.call(f.b,`/tasks/${target}/inquiries`,'POST',{recipientId:f.a.userId,body:'first'}),id=made.json.data.inquiryId;
  const first=(await f.call(f.a,`/tasks/${target}/inquiries`)).json.data.items[0].messages[0].messageId;
  expect((await f.call(f.b,`/tasks/${target}/inquiries`)).json.data.items).toHaveLength(1);
  expect((await f.call(f.b,`/tasks/${requesterTask}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.a,`/tasks/${requesterTask}/inquiries`)).json.data.items).toHaveLength(0);
  const second=(await f.call(f.b,`/task-inquiries/${id}/messages`,'POST',{body:'second'})).json.data.messageId;
  const notice=await env.DB.prepare("SELECT url FROM notification_events WHERE event_key=?1").bind(`task_inquiry:${first}`).first<{url:string}>();
  expect(notice!.url).toBe(`/app/projects/${f.project}/tasks?task=${target}&taskAction=inquiries`);
  expect((await f.call(f.a,'/task-inquiries/unread')).json.data.items).toEqual([{taskId:target,unreadCount:2}]);
  expect((await f.call(f.owner,'/task-inquiries/unread')).json.data.items).toEqual([]);
  expect((await f.call(f.a,`/tasks/${requesterTask}/inquiries/read`,'POST',{messageIds:[first]})).json.data.readCount).toBe(0);
  expect((await f.call(f.owner,`/tasks/${target}/inquiries/read`,'POST',{messageIds:[first]})).json.data.readCount).toBe(0);
  expect((await f.call(f.a,`/tasks/${target}/inquiries/read`,'POST',{messageIds:[first,newId()]})).json.data.readCount).toBe(1);
  expect((await f.call(f.a,'/task-inquiries/unread')).json.data.items).toEqual([{taskId:target,unreadCount:1}]);
  expect((await f.call(f.a,`/tasks/${target}/inquiries/read`,'POST',{messageIds:[first]})).json.data.readCount).toBe(0);
  const response=(await f.call(f.a,`/task-inquiries/${id}/messages`,'POST',{body:'reply'})).json.data.messageId;
  const replyNotice=await env.DB.prepare('SELECT url FROM notification_events WHERE event_key=?1').bind(`task_inquiry:${response}`).first<{url:string}>();
  expect(replyNotice!.url).toBe(`/app/projects/${f.project}/tasks?task=${target}&taskAction=inquiries`);
  expect((await f.call(f.b,'/task-inquiries/unread')).json.data.items).toEqual([{taskId:target,unreadCount:1}]);
  expect((await f.call(f.a,`/tasks/${target}/inquiries/read`,'POST',{messageIds:[second]})).json.data.readCount).toBe(1);
  expect((await f.call(f.a,'/task-inquiries/unread')).json.data.items).toEqual([]);
  expect((await f.call(f.b,`/tasks/${target}/inquiries/read`,'POST',{messageIds:[response]})).json.data.readCount).toBe(1);
  expect((await f.call(f.b,'/task-inquiries/unread')).json.data.items).toEqual([]);
  expect((await f.call(f.b,`/tasks/${target}/inquiries/read`,'POST',{messageIds:Array.from({length:201},()=>newId())})).status).toBe(400);
 });
});
