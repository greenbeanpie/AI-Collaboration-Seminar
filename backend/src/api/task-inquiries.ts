import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { parsePaging, nextCursor } from '../core/pagination';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { notFound, invalidState } from '../core/errors';
import { notificationStatements } from '../services/notifications';
import { withIdempotency } from '../services/idempotency';

const base='/api/v1/projects/{projectId}';
const params=z.object({projectId:z.string().uuid(),taskId:z.string().uuid()});
const message=z.object({messageId:z.string(),authorId:z.string(),authorName:z.string(),body:z.string(),createdAt:z.string()});
const inquiry=z.object({inquiryId:z.string(),taskId:z.string(),upstreamTaskId:z.string(),taskTitle:z.string(),upstreamTitle:z.string(),requesterId:z.string(),requesterName:z.string(),recipientId:z.string(),recipientName:z.string(),recipientSource:z.enum(['submission','completion','substitute','direct']),createdAt:z.string(),messages:z.array(message)});
const list=createRoute({method:'get',path:base+'/tasks/{taskId}/inquiries',request:{params,query:z.object({cursor:z.string().optional(),limit:z.string().optional()})},responses:{200:{description:'当前任务中的私密一对一质询工单',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(inquiry),nextCursor:z.string().nullable()}),'TaskInquiryListResponse')}}}}});
const create=createRoute({method:'post',path:base+'/tasks/{taskId}/inquiries',request:{params,body:{required:true,content:{'application/json':{schema:z.object({recipientId:z.string().uuid(),body:z.string().trim().min(1).max(4000)}).strict()}}}},responses:{201:{description:'一对一任务质询工单已创建',content:{'application/json':{schema:apiEnvelope(z.object({inquiryId:z.string().uuid()}),'TaskInquiryCreatedResponse')}}}}});
const reply=createRoute({method:'post',path:base+'/task-inquiries/{inquiryId}/messages',request:{params:z.object({projectId:z.string().uuid(),inquiryId:z.string().uuid()}),body:{required:true,content:{'application/json':{schema:z.object({body:z.string().trim().min(1).max(4000)}).strict()}}}},responses:{201:{description:'质询消息已发送',content:{'application/json':{schema:apiEnvelope(z.object({messageId:z.string().uuid()}),'TaskInquiryMessageCreatedResponse')}}}}});
const unread=createRoute({method:'get',path:base+'/task-inquiries/unread',request:{params:z.object({projectId:z.string().uuid()})},responses:{200:{description:'当前成员的任务质询未读数量',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(z.object({taskId:z.string().uuid(),unreadCount:z.number().int().nonnegative()}))}),'TaskInquiryUnreadResponse')}}}}});
const read=createRoute({method:'post',path:base+'/tasks/{taskId}/inquiries/read',request:{params,body:{required:true,content:{'application/json':{schema:z.object({messageIds:z.array(z.string().uuid()).max(200)}).strict()}}}},responses:{200:{description:'已展示的质询消息已读',content:{'application/json':{schema:apiEnvelope(z.object({readCount:z.number().int().nonnegative()}),'TaskInquiryReadResponse')}}}}});

export function registerTaskInquiryRoutes(app:OpenAPIHono<AppEnv>) {
 app.use('/api/v1/projects/:projectId/tasks/:taskId/inquiries',requireUser,requireProjectMember());
 app.use('/api/v1/projects/:projectId/tasks/:taskId/inquiries/read',requireUser,requireProjectMember());
 app.use('/api/v1/projects/:projectId/task-inquiries/unread',requireUser,requireProjectMember());
 app.use('/api/v1/projects/:projectId/task-inquiries/:inquiryId/messages',requireUser,requireProjectMember());

 app.openapi(list,async c=>{
  const {projectId,taskId}=c.req.valid('param'),userId=c.get('user')!.id;
  if(!await c.env.DB.prepare('SELECT id FROM tasks WHERE project_id=?1 AND id=?2').bind(projectId,taskId).first())throw notFound('任务不存在');
  const paging=parsePaging(c.req.valid('query'));
  // New tickets use one shared task id; this also preserves both historical sides of legacy threads.
  const rows=await c.env.DB.prepare("SELECT i.id inquiryId,i.task_id taskId,i.upstream_task_id upstreamTaskId,i.task_title taskTitle,i.upstream_title upstreamTitle,i.requester_id requesterId,u.display_name requesterName,i.recipient_id recipientId,v.display_name recipientName,CASE WHEN i.task_id=i.upstream_task_id THEN 'direct' ELSE i.recipient_source END recipientSource,i.created_at createdAt FROM task_inquiries i JOIN users u ON u.id=i.requester_id JOIN users v ON v.id=i.recipient_id WHERE i.project_id=?1 AND ((i.task_id=?2 AND i.requester_id=?3) OR (i.upstream_task_id=?2 AND i.recipient_id=?3)) AND (?4 IS NULL OR i.created_at>?4 OR (i.created_at=?4 AND i.id>?5)) ORDER BY i.created_at,i.id LIMIT ?6").bind(projectId,taskId,userId,paging.cursor?.createdAt??null,paging.cursor?.id??null,paging.limit+1).all<z.infer<typeof inquiry>>();
  const page=rows.results.slice(0,paging.limit);
  const messages=await c.env.DB.prepare(`SELECT m.inquiry_id inquiryId,m.id messageId,m.author_id authorId,u.display_name authorName,m.body,m.created_at createdAt
    FROM task_inquiry_messages m JOIN users u ON u.id=m.author_id JOIN task_inquiries i ON i.id=m.inquiry_id
    WHERE i.project_id=?1 AND m.inquiry_id IN(SELECT value FROM json_each(?2)) AND (i.requester_id=?3 OR i.recipient_id=?3)
    ORDER BY m.created_at,m.id`).bind(projectId,JSON.stringify(page.map(r=>r.inquiryId)),userId).all<z.infer<typeof message>&{inquiryId:string}>();
  const grouped=new Map<string,z.infer<typeof message>[]>();
  for(const {inquiryId,...message} of messages.results){const list=grouped.get(inquiryId)??[];list.push(message);grouped.set(inquiryId,list);}
  const items=page.map(item=>({...item,messages:grouped.get(item.inquiryId)??[]}));
  const last=page.at(-1);
  return c.json(apiData(c,{items,nextCursor:nextCursor(rows.results.length>paging.limit,last&&{createdAt:last.createdAt,id:last.inquiryId})??null}),200);
 });

 app.openapi(unread,async c=>{
  const {projectId}=c.req.valid('param'),userId=c.get('user')!.id;
  const rows=await c.env.DB.prepare("SELECT CASE WHEN i.requester_id=?2 THEN i.task_id ELSE i.upstream_task_id END taskId,COUNT(*) unreadCount FROM notification_inbox n JOIN notification_events e ON e.id=n.event_id JOIN task_inquiry_messages msg ON e.event_key='task_inquiry:'||msg.id JOIN task_inquiries i ON i.id=msg.inquiry_id WHERE n.user_id=?2 AND n.read_at IS NULL AND n.dismissed_at IS NULL AND e.kind='task_inquiry' AND e.resource_id=?1 AND i.project_id=?1 AND (i.requester_id=?2 OR i.recipient_id=?2) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2) GROUP BY taskId ORDER BY taskId").bind(projectId,userId).all<{taskId:string;unreadCount:number}>();
  return c.json(apiData(c,{items:rows.results}),200);
 });

 app.openapi(read,async c=>{
  const {projectId,taskId}=c.req.valid('param'),userId=c.get('user')!.id,{messageIds}=c.req.valid('json');
  if(!await c.env.DB.prepare('SELECT id FROM tasks WHERE project_id=?1 AND id=?2').bind(projectId,taskId).first())throw notFound('任务不存在');
  const result=await c.env.DB.prepare("UPDATE notification_inbox SET read_at=?4 WHERE user_id=?1 AND read_at IS NULL AND dismissed_at IS NULL AND EXISTS(SELECT 1 FROM notification_events e JOIN task_inquiry_messages msg ON e.event_key='task_inquiry:'||msg.id JOIN task_inquiries i ON i.id=msg.inquiry_id WHERE e.id=notification_inbox.event_id AND e.kind='task_inquiry' AND e.resource_id=?2 AND i.project_id=?2 AND msg.id IN(SELECT value FROM json_each(?5)) AND ((i.task_id=?3 AND i.requester_id=?1) OR (i.upstream_task_id=?3 AND i.recipient_id=?1)) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?1))").bind(userId,projectId,taskId,nowIso(),JSON.stringify(messageIds)).run();
  return c.json(apiData(c,{readCount:result.meta.changes}),200);
 });

 app.openapi(create,async c=>{
  const {projectId,taskId}=c.req.valid('param'),userId=c.get('user')!.id,b=c.req.valid('json');
  if(b.recipientId===userId)throw invalidState('请选择其他项目成员作为质询对象');
  if(!await c.env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId,b.recipientId).first())throw notFound('质询对象不在当前项目中');
  const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'inquiry:'+projectId+':'+taskId,rawBody:JSON.stringify(b)},async()=>{
   const inquiryId=newId(),messageId=newId(),now=nowIso();
   const rows=await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO task_inquiries(id,project_id,task_id,upstream_task_id,requester_id,recipient_id,recipient_source,task_title,upstream_title,created_at) SELECT ?1,?2,t.id,t.id,?3,?4,'substitute',t.title,t.title,?5 FROM tasks t WHERE t.id=?6 AND t.project_id=?2 AND t.archived_at IS NULL AND ?3!=?4 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4)").bind(inquiryId,projectId,userId,b.recipientId,now,taskId),
    c.env.DB.prepare('INSERT INTO task_inquiry_messages(id,inquiry_id,author_id,body,created_at) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM task_inquiries WHERE id=?2)').bind(messageId,inquiryId,userId,b.body,now),
    ...notificationStatements(c.env,{key:'task_inquiry:'+messageId,kind:'task_inquiry',scope:'project',resourceId:projectId,actorId:userId,recipientIds:[b.recipientId],url:'/app/projects/'+projectId+'/tasks?task='+taskId+'&taskAction=inquiries',record:{table:'task_inquiry_messages',id:messageId},now})
   ]);
   if(!rows[0]!.meta.changes)throw invalidState('任务或项目成员已变化，请刷新后重试');
   return {status:201 as const,body:{inquiryId}};
  });
  return c.json(apiData(c,result.body),201);
 });

 app.openapi(reply,async c=>{
  const {projectId,inquiryId}=c.req.valid('param'),userId=c.get('user')!.id,b=c.req.valid('json');
  const thread=await c.env.DB.prepare('SELECT task_id,upstream_task_id,requester_id,recipient_id FROM task_inquiries WHERE id=?1 AND project_id=?2 AND (requester_id=?3 OR recipient_id=?3)').bind(inquiryId,projectId,userId).first<{task_id:string;upstream_task_id:string;requester_id:string;recipient_id:string}>();
  if(!thread)throw notFound('质询不存在');
  const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'inquiry-reply:'+inquiryId,rawBody:JSON.stringify(b)},async()=>{
   const messageId=newId(),now=nowIso(),recipientId=thread.requester_id===userId?thread.recipient_id:thread.requester_id,recipientTaskId=thread.requester_id===userId?thread.upstream_task_id:thread.task_id;
   const rows=await c.env.DB.batch([c.env.DB.prepare("INSERT INTO task_inquiry_messages(id,inquiry_id,author_id,body,created_at) SELECT ?1,i.id,?3,?4,?5 FROM task_inquiries i WHERE i.id=?2 AND i.project_id=?6 AND (i.requester_id=?3 OR i.recipient_id=?3) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?6 AND user_id=?3)").bind(messageId,inquiryId,userId,b.body,now,projectId),...notificationStatements(c.env,{key:'task_inquiry:'+messageId,kind:'task_inquiry',scope:'project',resourceId:projectId,actorId:userId,recipientIds:[recipientId],url:'/app/projects/'+projectId+'/tasks?task='+recipientTaskId+'&taskAction=inquiries',record:{table:'task_inquiry_messages',id:messageId},now})]);
   if(!rows[0]!.meta.changes)throw invalidState('质询权限已变化');
   return {status:201 as const,body:{messageId}};
  });
  return c.json(apiData(c,result.body),201);
 });
}
