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
 it('prefers the accepted submitter and labels historical fallback without exposing other threads',async()=>{
  const f=await fixture(),up=await f.task(f.owner,'done'),down=await f.task(f.b),submission=newId();await f.edge(down,up);
  let choices=(await f.call(f.b,`/tasks/${down}/inquiries`)).json.data.candidates;expect(choices[0].recipientSource).toBe('substitute');
  await env.DB.prepare("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,criteria,task_revision,status,created_at,updated_at) VALUES(?1,?2,?3,1,?4,'成果','标准',1,'accept',?5,?5)").bind(submission,f.project,up,f.a.userId,nowIso()).run();
  await env.DB.prepare('UPDATE tasks SET current_submission_id=?2 WHERE id=?1').bind(up,submission).run();
  choices=(await f.call(f.b,`/tasks/${down}/inquiries`)).json.data.candidates;expect(choices[0].recipientId).toBe(f.a.userId);expect(choices[0].recipientSource).toBe('submission');
  expect((await f.call(f.owner,`/tasks/${down}/inquiries`,'POST',{upstreamTaskId:up,body:'wrong owner'})).status).toBe(409);
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
 it('private direct inquiries, participant replies, snapshots, idempotency and member revocation',async()=>{
  const f=await fixture(),up=await f.task(f.a),middle=await f.task(f.a),down=await f.task(f.b);await f.edge(middle,up);await f.edge(down,middle);
  await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=?1").bind(up).run();
  expect((await f.call(f.b,`/tasks/${down}/inquiries`,'POST',{upstreamTaskId:up,body:'indirect'})).status).toBe(409);
  await f.edge(down,up);
  const first=await f.call(f.b,`/tasks/${down}/inquiries`,'POST',{upstreamTaskId:up,body:'接口格式影响我的实现'},'inquiry-key');expect(first.status).toBe(201);
  const id=first.json.data.inquiryId;
  expect((await f.call(f.b,`/tasks/${down}/inquiries`,'POST',{upstreamTaskId:up,body:'接口格式影响我的实现'},'inquiry-key')).json.data.inquiryId).toBe(id);
  expect((await f.call(f.owner,`/tasks/${down}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.a,`/tasks/${down}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.b,`/tasks/${up}/inquiries`)).json.data.items).toHaveLength(0);
  expect((await f.call(f.a,`/tasks/${up}/inquiries`)).json.data.items).toHaveLength(1);
  expect((await f.call(f.owner,`/task-inquiries/${id}/messages`,'POST',{body:'admin'})).status).toBe(404);
  expect((await f.call(f.a,`/task-inquiries/${id}/messages`,'POST',{body:'使用 JSON'})).status).toBe(201);
  await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(up,f.owner.userId).run();
  const thread=(await f.call(f.b,`/tasks/${down}/inquiries`)).json.data.items[0];expect(thread.recipientId).toBe(f.a.userId);expect(thread.recipientSource).toBe('completion');expect(thread.messages).toHaveLength(2);
  await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.project,f.a.userId).run();
  expect((await f.call(f.a,`/task-inquiries/${id}/messages`,'POST',{body:'gone'})).status).toBe(403);
  expect((await f.call(f.a,'/task-inquiries/unread')).status).toBe(403);
  expect((await f.call(f.a,`/tasks/${up}/inquiries/read`,'POST',{messageIds:[]})).status).toBe(403);
 });
 it('routes each side to its own task and marks only displayed private messages read',async()=>{
  const f=await fixture(),up=await f.task(f.a,'done'),down=await f.task(f.b);await f.edge(down,up);
  const made=await f.call(f.b,`/tasks/${down}/inquiries`,'POST',{upstreamTaskId:up,body:'first'}),id=made.json.data.inquiryId;
  const first=(await f.call(f.a,`/tasks/${up}/inquiries`)).json.data.items[0].messages[0].messageId;
  const second=(await f.call(f.b,`/task-inquiries/${id}/messages`,'POST',{body:'second'})).json.data.messageId;
  const notice=await env.DB.prepare("SELECT url FROM notification_events WHERE event_key=?1").bind(`task_inquiry:${first}`).first<{url:string}>();
  expect(notice!.url).toBe(`/app/projects/${f.project}/tasks?task=${up}&taskAction=inquiries`);
  expect((await f.call(f.a,'/task-inquiries/unread')).json.data.items).toEqual([{taskId:up,unreadCount:2}]);
  expect((await f.call(f.owner,'/task-inquiries/unread')).json.data.items).toEqual([]);
  expect((await f.call(f.a,`/tasks/${down}/inquiries/read`,'POST',{messageIds:[first]})).json.data.readCount).toBe(0);
  expect((await f.call(f.owner,`/tasks/${up}/inquiries/read`,'POST',{messageIds:[first]})).json.data.readCount).toBe(0);
  expect((await f.call(f.a,`/tasks/${up}/inquiries/read`,'POST',{messageIds:[first,newId()]})).json.data.readCount).toBe(1);
  expect((await f.call(f.a,'/task-inquiries/unread')).json.data.items).toEqual([{taskId:up,unreadCount:1}]);
  expect((await f.call(f.a,`/tasks/${up}/inquiries/read`,'POST',{messageIds:[first]})).json.data.readCount).toBe(0);
  const response=(await f.call(f.a,`/task-inquiries/${id}/messages`,'POST',{body:'reply'})).json.data.messageId;
  const replyNotice=await env.DB.prepare('SELECT url FROM notification_events WHERE event_key=?1').bind(`task_inquiry:${response}`).first<{url:string}>();
  expect(replyNotice!.url).toBe(`/app/projects/${f.project}/tasks?task=${down}&taskAction=inquiries`);
  expect((await f.call(f.b,'/task-inquiries/unread')).json.data.items).toEqual([{taskId:down,unreadCount:1}]);
  expect((await f.call(f.a,`/tasks/${up}/inquiries/read`,'POST',{messageIds:[second]})).json.data.readCount).toBe(1);
  expect((await f.call(f.a,'/task-inquiries/unread')).json.data.items).toEqual([]);
  expect((await f.call(f.b,`/tasks/${down}/inquiries/read`,'POST',{messageIds:[response]})).json.data.readCount).toBe(1);
  expect((await f.call(f.b,'/task-inquiries/unread')).json.data.items).toEqual([]);
  expect((await f.call(f.b,`/tasks/${down}/inquiries/read`,'POST',{messageIds:Array.from({length:201},()=>newId())})).status).toBe(400);
 });
});
