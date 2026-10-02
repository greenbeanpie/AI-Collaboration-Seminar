import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
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
const inquiry=z.object({inquiryId:z.string(),taskId:z.string(),upstreamTaskId:z.string(),taskTitle:z.string(),upstreamTitle:z.string(),requesterId:z.string(),requesterName:z.string(),recipientId:z.string(),recipientName:z.string(),recipientSource:z.enum(['submission','completion','substitute']),createdAt:z.string(),messages:z.array(message)});
const candidate=z.object({taskId:z.string(),title:z.string(),recipientId:z.string(),recipientName:z.string(),recipientSource:z.enum(['submission','completion','substitute'])});
const list=createRoute({method:'get',path:base+'/tasks/{taskId}/inquiries',request:{params},responses:{200:{description:'私有任务质询',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(inquiry),candidates:z.array(candidate)}),'TaskInquiryListResponse')}}}}});
const create=createRoute({method:'post',path:base+'/tasks/{taskId}/inquiries',request:{params,body:{required:true,content:{'application/json':{schema:z.object({upstreamTaskId:z.string().uuid(),body:z.string().trim().min(1).max(4000)}).strict()}}}},responses:{201:{description:'质询已发起',content:{'application/json':{schema:apiEnvelope(z.object({inquiryId:z.string().uuid()}),'TaskInquiryCreatedResponse')}}}}});
const reply=createRoute({method:'post',path:base+'/task-inquiries/{inquiryId}/messages',request:{params:z.object({projectId:z.string().uuid(),inquiryId:z.string().uuid()}),body:{required:true,content:{'application/json':{schema:z.object({body:z.string().trim().min(1).max(4000)}).strict()}}}},responses:{201:{description:'质询消息已发送',content:{'application/json':{schema:apiEnvelope(z.object({messageId:z.string().uuid()}),'TaskInquiryMessageCreatedResponse')}}}}});
// UNION terminates even for malformed historical cycles. Only completed transitive upstream tasks qualify.
const candidatesSql=`WITH RECURSIVE ancestors(id) AS (SELECT depends_on_task_id FROM task_dependencies WHERE project_id=?1 AND task_id=?2 UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id WHERE d.project_id=?1), people AS (
 SELECT t.id taskId,t.title,COALESCE(s.submitted_by,c.user_id,t.assignee_id) recipientId,
 CASE WHEN s.submitted_by IS NOT NULL THEN 'submission' WHEN c.user_id IS NOT NULL THEN 'completion' ELSE 'substitute' END recipientSource
 FROM tasks t JOIN ancestors a ON a.id=t.id LEFT JOIN task_submissions s ON s.id=t.current_submission_id AND s.status='accept' LEFT JOIN task_completion_people c ON c.task_id=t.id
 WHERE t.project_id=?1 AND t.status='done' AND t.id!=?2)
 SELECT people.*,u.display_name recipientName FROM people JOIN users u ON u.id=people.recipientId JOIN project_members m ON m.project_id=?1 AND m.user_id=people.recipientId`;
const candidateGuardSql=candidatesSql.replace(/\?[12]/g,parameter=>parameter==='?1'?'?2':'?3');
type Candidate={taskId:string;title:string;recipientId:string;recipientName:string;recipientSource:'submission'|'completion'|'substitute'};
export function registerTaskInquiryRoutes(app:OpenAPIHono<AppEnv>) {
 app.use('/api/v1/projects/:projectId/tasks/:taskId/inquiries',requireUser,requireProjectMember());
 app.use('/api/v1/projects/:projectId/task-inquiries/:inquiryId/messages',requireUser,requireProjectMember());
 app.openapi(list,async c=>{
  const {projectId,taskId}=c.req.valid('param'),userId=c.get('user')!.id;
  const task=await c.env.DB.prepare('SELECT assignee_id,status FROM tasks WHERE project_id=?1 AND id=?2').bind(projectId,taskId).first<{assignee_id:string|null;status:string}>();
  if(!task)throw notFound('任务不存在');
  const rows=await c.env.DB.prepare(`SELECT i.id inquiryId,i.task_id taskId,i.upstream_task_id upstreamTaskId,i.task_title taskTitle,i.upstream_title upstreamTitle,i.requester_id requesterId,u.display_name requesterName,i.recipient_id recipientId,v.display_name recipientName,i.recipient_source recipientSource,i.created_at createdAt FROM task_inquiries i JOIN users u ON u.id=i.requester_id JOIN users v ON v.id=i.recipient_id WHERE i.project_id=?1 AND (i.task_id=?2 OR i.upstream_task_id=?2) AND (i.requester_id=?3 OR i.recipient_id=?3) ORDER BY i.created_at,i.id`).bind(projectId,taskId,userId).all<z.infer<typeof inquiry>>();
  const items=await Promise.all(rows.results.map(async i=>({...i,messages:(await c.env.DB.prepare('SELECT m.id messageId,author_id authorId,u.display_name authorName,body,m.created_at createdAt FROM task_inquiry_messages m JOIN users u ON u.id=m.author_id WHERE inquiry_id=?1 ORDER BY m.created_at,m.id').bind(i.inquiryId).all<z.infer<typeof message>>()).results})));
  const candidates=task.assignee_id===userId&&task.status!=='done'?(await c.env.DB.prepare(candidatesSql).bind(projectId,taskId).all<Candidate>()).results.filter(i=>i.recipientId!==userId):[];
  return c.json(apiData(c,{items,candidates}),200);
 });
 app.openapi(create,async c=>{
  const {projectId,taskId}=c.req.valid('param'),userId=c.get('user')!.id,b=c.req.valid('json');
  const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:`inquiry:${projectId}:${taskId}`,rawBody:JSON.stringify(b)},async()=>{
   const upstream=(await c.env.DB.prepare(candidatesSql).bind(projectId,taskId).all<Candidate>()).results.find(t=>t.taskId===b.upstreamTaskId);
   if(!upstream||upstream.recipientId===userId)throw invalidState('请选择已完成且仍有组员负责的前置任务');
   const id=newId(),msgId=newId(),now=nowIso();
   const rows=await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO task_inquiries(id,project_id,task_id,upstream_task_id,requester_id,recipient_id,recipient_source,task_title,upstream_title,created_at)
    SELECT ?1,?2,t.id,?4,?5,?6,?7,t.title,?8,?9 FROM tasks t WHERE t.id=?3 AND t.project_id=?2 AND t.assignee_id=?5 AND t.status!='done'
    AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?5) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6)
    AND EXISTS(SELECT 1 FROM (${candidateGuardSql}) live WHERE live.taskId=?4 AND live.recipientId=?6 AND live.recipientSource=?7)`)
    .bind(id,projectId,taskId,upstream.taskId,userId,upstream.recipientId,upstream.recipientSource,upstream.title,now),
    c.env.DB.prepare('INSERT INTO task_inquiry_messages(id,inquiry_id,author_id,body,created_at) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM task_inquiries WHERE id=?2)').bind(msgId,id,userId,b.body,now),
    ...notificationStatements(c.env,{key:`task_inquiry:${msgId}`,kind:'task_inquiry',scope:'project',resourceId:projectId,actorId:userId,recipientIds:[upstream.recipientId],url:`/app/projects/${projectId}/tasks?task=${taskId}`,record:{table:'task_inquiry_messages',id:msgId},now})
   ]);
   if(!rows[0]!.meta.changes)throw invalidState('任务分工、前置任务或成员已变化，请刷新');
   return {status:201 as const,body:{inquiryId:id}};
  });
  return c.json(apiData(c,result.body),201);
 });
 app.openapi(reply,async c=>{
  const {projectId,inquiryId}=c.req.valid('param'),userId=c.get('user')!.id,b=c.req.valid('json');
  const thread=await c.env.DB.prepare('SELECT task_id,requester_id,recipient_id FROM task_inquiries WHERE id=?1 AND project_id=?2 AND (requester_id=?3 OR recipient_id=?3)').bind(inquiryId,projectId,userId).first<{task_id:string;requester_id:string;recipient_id:string}>();
  if(!thread)throw notFound('质询不存在');
  const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:`inquiry-reply:${inquiryId}`,rawBody:JSON.stringify(b)},async()=>{
   const id=newId(),now=nowIso(),recipientId=thread.requester_id===userId?thread.recipient_id:thread.requester_id;
   const rows=await c.env.DB.batch([c.env.DB.prepare(`INSERT INTO task_inquiry_messages(id,inquiry_id,author_id,body,created_at) SELECT ?1,i.id,?3,?4,?5 FROM task_inquiries i WHERE i.id=?2 AND i.project_id=?6 AND (i.requester_id=?3 OR i.recipient_id=?3) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?6 AND user_id=?3)`).bind(id,inquiryId,userId,b.body,now,projectId),...notificationStatements(c.env,{key:`task_inquiry:${id}`,kind:'task_inquiry',scope:'project',resourceId:projectId,actorId:userId,recipientIds:[recipientId],url:`/app/projects/${projectId}/tasks?task=${thread.task_id}`,record:{table:'task_inquiry_messages',id},now})]);
   if(!rows[0]!.meta.changes)throw invalidState('质询权限已变化');
   return {status:201 as const,body:{messageId:id}};
  });
  return c.json(apiData(c,result.body),201);
 });
}
