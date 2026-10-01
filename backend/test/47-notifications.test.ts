import { beforeEach, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser, type SeededUser } from './helpers/seed';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { newId, nowIso, sha256Hex } from '../src/core/db';
import { dispatchNotifications, notificationStatements } from '../src/services/notifications';
import * as webPush from '../src/services/web-push';

// Public RFC 8291 fixture, not live VAPID material.
const pushEnv={...env,VAPID_PUBLIC_KEY:'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',VAPID_PRIVATE_KEY:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',VAPID_SUBJECT:'https://example.test'};
const keys={p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'};
const app=createApp();
async function call(user:SeededUser|undefined,path:string,method='GET',body?:unknown,bindings:Env=env,headers:Record<string,string>={}){
  return app.request(`${BASE}/api/v1${path}`,{method,headers:{...(user?{cookie:authCookie(user.token)}:{}),...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})},bindings);
}
async function data<T>(response:Response):Promise<T>{expect(response.status).toBeLessThan(300);return (await response.json() as {data:T}).data;}
interface Item{id:string;kind:string;title:string;body:string;url:string;readAt:string|null;dismissedAt:string|null}
interface Feed{items:Item[];nextCursor:string|null;unreadCount:number}
async function feed(user:SeededUser,suffix=''){return data<Feed>(await call(user,`/notifications${suffix}`));}
async function source(user:SeededUser,projectId:string,bindings:Env=env){return data<{sourceId:string;sourceVersionId:string}>(await call(user,`/projects/${projectId}/sources`,'POST',{kind:'paste',title:'PRIVATE TITLE',text:'SECRET BODY'},bindings));}
async function sub(user:SeededUser,name:string){return data<{id:string}>(await call(user,'/notifications/push/subscriptions','POST',{endpoint:`https://fcm.googleapis.com/send/${name}`,...{keys}},pushEnv));}
beforeEach(async()=>{await env.DB.prepare('DELETE FROM auth_password_rate_limits').run();});
it('requires password sessions; defaults on; unconfigured push fails closed and keeps real in-app events',async()=>{
 expect((await call(undefined,'/notifications')).status).toBe(401);
 const user=await seedUser();const project=await seedProject(user.userId);
 expect(await data(await call(user,'/notifications/settings'))).toEqual({inAppEnabled:true,pushEnabled:true});
 expect(await data(await call(user,'/notifications/push/status'))).toEqual({configured:false,publicKey:''});
 expect((await call(user,'/notifications/push/subscriptions','POST',{endpoint:'https://fcm.googleapis.com/send/never',keys})).status).toBe(503);
 await source(user,project);const result=await feed(user);expect(result.items).toHaveLength(1);expect(result.unreadCount).toBe(1);expect(JSON.stringify(result)).not.toMatch(/PRIVATE TITLE|SECRET BODY/);
 expect(result.items[0]!.url).toBe(`/app/projects/${project}/sources`);
 const mock=vi.spyOn(webPush,'sendWebPush');await dispatchNotifications(env);expect(mock).not.toHaveBeenCalled();mock.mockRestore();
});
it('persists scoped history/read/dismiss with stable cursor and immediately applies membership loss',async()=>{
 const owner=await seedUser(),member=await seedUser(),outsider=await seedUser();const project=await seedProject(owner.userId);
 await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),project,member.userId,nowIso()).run();
 for(let n=0;n<3;n++)await source(owner,project);
 const first=await feed(member,'?limit=1');expect(first.items).toHaveLength(1);expect(first.unreadCount).toBe(3);expect(first.nextCursor).toBeTruthy();
 const second=await feed(member,`?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
 expect((await feed(outsider)).items).toEqual([]);
 expect((await call(outsider,`/notifications/${first.items[0]!.id}/read`,'POST')).status).toBe(404);
 const read=await data<Item>(await call(member,`/notifications/${first.items[0]!.id}/read`,'POST'));expect(read.readAt).toBeTruthy();
 expect((await data<Item>(await call(member,`/notifications/${first.items[0]!.id}/read`,'POST'))).readAt).toBe(read.readAt);
 await data(await call(member,`/notifications/${second.items[0]!.id}/dismiss`,'POST'));expect((await feed(member)).unreadCount).toBe(1);expect((await feed(member)).items).toHaveLength(3);
 await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(project,member.userId).run();
 expect((await feed(member)).items).toEqual([]);expect((await call(member,`/notifications/${first.items[0]!.id}/dismiss`,'POST')).status).toBe(404);
 expect((await feed(owner)).unreadCount).toBe(3);
 for(const q of ['?cursor=oops','?limit=0','?limit=101'])expect((await call(owner,`/notifications${q}`)).status).toBe(400);
 expect((await call(owner,'/notifications')).headers.get('cache-control')).toBe('no-store');
});
it('subscription ownership cannot be transferred; lookup and recoverable revoke are owner-only; logout only revokes current device',async()=>{
 const user=await seedUser(),other=await seedUser();const a=await sub(user,'device-a');const b=await sub(user,'device-b');
 expect((await call(other,'/notifications/push/subscriptions','POST',{endpoint:'https://fcm.googleapis.com/send/device-a',keys},pushEnv)).status).toBe(409);
 expect(await data(await call(other,'/notifications/push/lookup','POST',{endpoint:'https://fcm.googleapis.com/send/device-a'}))).toEqual({id:null});
 expect((await call(other,`/notifications/push/subscriptions/${a.id}`,'DELETE')).status).toBe(404);
 await data(await call(user,`/notifications/push/subscriptions/${a.id}`,'DELETE'));
 expect((await call(other,'/notifications/push/subscriptions','POST',{endpoint:'https://fcm.googleapis.com/send/device-a',keys},pushEnv)).status).toBe(409);
 expect((await sub(user,'device-a')).id).toBe(a.id);
 await data(await call(user,'/auth/session','DELETE',undefined,env,{'X-Push-Subscription-Id':a.id}));
 const rows=await env.DB.prepare('SELECT id,disabled_at FROM push_subscriptions WHERE user_id=?1').bind(user.userId).all<{id:string;disabled_at:string|null}>();
 expect(rows.results.find(x=>x.id===a.id)?.disabled_at).toBeTruthy();expect(rows.results.find(x=>x.id===b.id)?.disabled_at).toBeNull();
});
it('event and outbox fanout are idempotent, respect settings and recheck membership before dispatch',async()=>{
 const user=await seedUser();const project=await seedProject(user.userId);await sub(user,'event-dedupe');const created=await source(user,project,pushEnv);
 const event={key:`source_added:${created.sourceId}`,kind:'source_added' as const,scope:'project' as const,resourceId:project,url:`/app/projects/${project}/sources`,record:{table:'sources' as const,id:created.sourceId}};
 await env.DB.batch(notificationStatements(pushEnv,event));expect((await feed(user)).items).toHaveLength(1);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_push_outbox o JOIN push_subscriptions s ON s.id=o.subscription_id WHERE s.user_id=?1').bind(user.userId).first<{n:number}>())?.n).toBe(1);
 const mock=vi.spyOn(webPush,'sendWebPush').mockResolvedValue({status:201});
 try {
  await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(project,user.userId).run();await dispatchNotifications(pushEnv);expect(mock).not.toHaveBeenCalled();
  const user2=await seedUser();const project2=await seedProject(user2.userId);await sub(user2,'disabled');
  await data(await call(user2,'/notifications/settings','PUT',{inAppEnabled:false,pushEnabled:false}));await source(user2,project2,pushEnv);
  expect((await feed(user2)).items).toHaveLength(1);await dispatchNotifications(pushEnv);expect(mock).not.toHaveBeenCalled();
 } finally {mock.mockRestore();}
});
it('dispatch persists success once, retries transient failures, and disables expired endpoints without deleting them',async()=>{
 const user=await seedUser();const project=await seedProject(user.userId);const device=await sub(user,'dispatch');await source(user,project,pushEnv);
 const mock=vi.spyOn(webPush,'sendWebPush').mockResolvedValue({status:503});
 try {
  await dispatchNotifications(pushEnv);expect(mock).toHaveBeenCalledTimes(1);
  await env.DB.prepare("UPDATE notification_push_outbox SET available_at=?1 WHERE status='pending'").bind('2020-01-01T00:00:00.000Z').run();mock.mockResolvedValue({status:201});await dispatchNotifications(pushEnv);await dispatchNotifications(pushEnv);expect(mock).toHaveBeenCalledTimes(2);
  await source(user,project,pushEnv);mock.mockResolvedValue({status:410});await dispatchNotifications(pushEnv);
  expect((await env.DB.prepare('SELECT disabled_reason FROM push_subscriptions WHERE id=?1').bind(device.id).first<{disabled_reason:string}>())?.disabled_reason).toBe('expired');
  expect((await feed(user)).items).toHaveLength(2);
 } finally {mock.mockRestore();}
});
it('support replies/status target owner and current staff with generic text, and demotion immediately hides staff history',async()=>{
 const owner=await seedUser(),admin=await seedUser(),other=await seedUser();await env.DB.prepare("UPDATE auth_accounts SET account_role='admin' WHERE user_id=?1").bind(admin.userId).run();
 const created=await data<{ticket:{id:string;revision:number}}>(await call(owner,'/support/tickets','POST',{title:'PRIVATE TICKET',body:'PRIVATE MESSAGE'}));const id=created.ticket.id;
 await data(await call(owner,`/support/tickets/${id}/messages`,'POST',{body:'secret owner reply'}));expect((await feed(admin)).items[0]!.kind).toBe('ticket_reply');expect((await feed(other)).items).toEqual([]);
 await data(await call(admin,`/support/tickets/${id}/messages`,'POST',{body:'secret staff reply'}));await data(await call(admin,`/support/tickets/${id}/status`,'PATCH',{status:'resolved',revision:1}));
 const history=await feed(owner);expect(history.items.map(x=>x.kind).sort()).toEqual(['ticket_reply','ticket_status']);expect(JSON.stringify(history)).not.toMatch(/PRIVATE|secret/);expect(history.items[0]!.url).toBe(`/app/support/${id}`);
 await env.DB.prepare("UPDATE auth_accounts SET account_role='user',is_admin=0 WHERE user_id=?1").bind(admin.userId).run();expect((await feed(admin)).items).toEqual([]);
});
it('logout with another-session subscription header cannot revoke another device',async()=>{
 const user=await seedUser();const device=await sub(user,'another-session');await env.DB.prepare('UPDATE push_subscriptions SET session_hash=?2 WHERE id=?1').bind(device.id,await sha256Hex('other-device-token')).run();
 await data(await call(user,'/auth/session','DELETE',undefined,env,{'X-Push-Subscription-Id':device.id}));
 expect((await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(device.id).first<{disabled_at:string|null}>())?.disabled_at).toBeNull();
});
it('revoked and expired password sessions suppress queued pushes',async()=>{
 const mock=vi.spyOn(webPush,'sendWebPush').mockResolvedValue({status:201});
 try {
  for(const state of ['revoked','expired']){
   const user=await seedUser();const project=await seedProject(user.userId);await sub(user,`session-${state}`);await source(user,project,pushEnv);
   if(state==='revoked')await env.DB.prepare('UPDATE sessions SET revoked_at=?2 WHERE user_id=?1').bind(user.userId,nowIso()).run();
   else await env.DB.prepare('UPDATE sessions SET expires_at=?2 WHERE user_id=?1').bind(user.userId,'2020-01-01T00:00:00.000Z').run();
   await dispatchNotifications(pushEnv);
  }
  expect(mock).not.toHaveBeenCalled();
 }finally{mock.mockRestore();}
});
it('a retried requirement edit with one intent emits one event; forged subscription fields and origins fail',async()=>{
 const user=await seedUser();const project=await seedProject(user.userId);const setId=newId(),requirementId=newId(),now=nowIso();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO requirement_sets(id,project_id,status,revision,created_at,updated_at) VALUES(?1,?2,'draft',1,?3,?3)").bind(setId,project,now),
  env.DB.prepare("INSERT INTO requirements(id,requirement_set_id,project_id,seq,category,title,detail,due_precision,citations_json,field_state,updated_at) VALUES(?1,?2,?3,1,'other','initial','text','unknown','[]','ai_suggestion',?4)").bind(requirementId,setId,project,now),
 ]);
 for(let n=0;n<2;n++)await data(await call(user,`/projects/${project}/requirements/${requirementId}`,'PATCH',{title:'private changed title'},env,{'idempotency-key':'one-intent'}));
 expect((await feed(user)).items.filter(item=>item.kind==='requirement_changed')).toHaveLength(1);
 expect((await call(user,'/notifications/push/subscriptions','POST',{endpoint:'https://fcm.googleapis.com/send/forged',keys,userId:newId()},pushEnv)).status).toBe(400);
 expect((await call(user,'/notifications/settings','PUT',{inAppEnabled:true,pushEnabled:true},env,{Origin:'https://evil.test'})).status).toBe(403);
 expect((await call(user,'/notifications/push/subscriptions','POST',{endpoint:'https://evil.test/send',keys},pushEnv)).status).toBe(400);
});
