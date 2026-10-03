import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound } from '../core/errors';
import { projectParams } from './projects';
import { projectPermissionSql, requireProjectPermission } from '../services/project-permissions';
import { resolveInviteRecipients, sendUsernameInvite } from '../services/username-invitations';
const item=z.object({id:z.string(),username:z.string(),requestedBy:z.string(),status:z.enum(['pending','approved','rejected']),revision:z.number(),createdAt:z.string()});
type RequestItem=z.infer<typeof item>;
const response=apiEnvelope(item,'InvitationRequestResponse');
export function registerInvitationRequestRoutes(app:OpenAPIHono<AppEnv>){
 const path='/api/v1/projects/{projectId}/invitation-requests';
 app.use('/api/v1/projects/:projectId/invitation-requests',requireUser,requireProjectMember());
 app.use('/api/v1/projects/:projectId/invitation-requests/*',requireUser,requireProjectMember());
 app.openapi(createRoute({method:'get',path,tags:['invitations'],request:{params:projectParams},responses:{200:{description:'本人的申请或管理员审批队列',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(item)}),'InvitationRequestListResponse')}}}}}),async c=>{
  const p=c.get('member')!.projectId,u=c.get('user')!.id;
  const rows=await c.env.DB.prepare(`SELECT id,username,requested_by requestedBy,status,revision,created_at createdAt FROM project_invitation_requests WHERE project_id=?1 AND (requested_by=?2 OR ${projectPermissionSql('?1','?2','grant')}) ORDER BY created_at DESC LIMIT 100`).bind(p,u).all<RequestItem>();
  return c.json(apiData(c,{items:rows.results}),200);
 });
 app.openapi(createRoute({method:'post',path,tags:['invitations'],request:{params:projectParams,body:{required:true,content:{'application/json':{schema:z.object({username:z.string().trim().min(1).max(64)}).strict()}}}},responses:{201:{description:'等待管理员批准',content:{'application/json':{schema:response}}}}}),async c=>{
  const p=c.get('member')!.projectId,u=c.get('user')!.id,b=c.req.valid('json');
  const [recipient]=await resolveInviteRecipients(c.env,u,[b.username]);
  const id=newId(),now=nowIso();
  await c.env.DB.prepare(`INSERT INTO project_invitation_requests(id,project_id,requested_by,username,created_at) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM projects WHERE id=?2 AND status='active') AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3) AND NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6) ON CONFLICT DO NOTHING`).bind(id,p,u,recipient!.username,now,recipient!.userId).run();
  const row=await c.env.DB.prepare("SELECT id,username,requested_by requestedBy,status,revision,created_at createdAt FROM project_invitation_requests WHERE project_id=?1 AND requested_by=?2 AND username=?3 AND status='pending'").bind(p,u,recipient!.username).first<RequestItem>();
  if(!row)throw invalidState('项目已归档或对方已是成员');
  return c.json(apiData(c,row),201);
 });
 app.openapi(createRoute({method:'post',path:path+'/{requestId}/decide',tags:['invitations'],request:{params:projectParams.extend({requestId:z.string().uuid()}),body:{required:true,content:{'application/json':{schema:z.object({expectedRevision:z.number().int().min(1),action:z.enum(['approve','reject'])}).strict()}}}},responses:{200:{description:'审批结果',content:{'application/json':{schema:response}}}}}),async c=>{
  const p=c.get('member')!.projectId,u=c.get('user')!.id,id=c.req.valid('param').requestId,b=c.req.valid('json');
  await requireProjectPermission(c.env,p,u,'grant');
  const row=await c.env.DB.prepare('SELECT * FROM project_invitation_requests WHERE id=?1 AND project_id=?2').bind(id,p).first<{username:string;status:string;revision:number;expires_in_days:number}>();
  if(!row)throw notFound('申请不存在');
  if(row.status!=='pending'||row.revision!==b.expectedRevision)throw invalidState('申请已被处理，请刷新');
  if(b.action==='approve')await sendUsernameInvite(c.env,p,u,row.username,row.expires_in_days,id);
  else {const r=await c.env.DB.prepare(`UPDATE project_invitation_requests SET status='rejected',revision=revision+1,decided_by=?3,decided_at=?4 WHERE id=?1 AND project_id=?2 AND status='pending' AND revision=?5 AND ${projectPermissionSql('?2','?3','grant')}`).bind(id,p,u,nowIso(),b.expectedRevision).run();if(!r.meta.changes)throw invalidState('申请已变化');}
  const latest=await c.env.DB.prepare('SELECT id,username,requested_by requestedBy,status,revision,created_at createdAt FROM project_invitation_requests WHERE id=?1').bind(id).first<RequestItem>();
  if((latest as {status:string}).status!== (b.action==='approve'?'approved':'rejected'))throw invalidState('审批已变化');
  return c.json(apiData(c,latest!),200);
 });
}
