import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { withIdempotency } from '../services/idempotency';
import { assertChatMember,chatHistorySchema,chatOperationsSchema,enqueueChat,readChat,readChatOperations,clearChat } from '../services/project-ai-chat';
const params=z.object({projectId:z.string().uuid()});
const query=z.object({cursor:z.string().regex(/^\d+$/).optional()});
const base='/api/v1/projects/{projectId}/ai-chat';
const get=createRoute({method:'get',path:base,tags:['project-ai-chat'],request:{params,query},responses:{200:{description:'个人问答历史',content:{'application/json':{schema:apiEnvelope(chatHistorySchema,'ProjectChatHistoryResponse')}}}}});
const post=createRoute({method:'post',path:base,tags:['project-ai-chat'],request:{params,body:{required:true,content:{'application/json':{schema:z.object({content:z.string().trim().min(1).max(4000)}).strict()}}}},responses:{202:{description:'问答已排队',content:{'application/json':{schema:apiEnvelope(z.object({questionId:z.string().uuid(),jobId:z.string().uuid()}),'ProjectChatEnqueuedResponse')}}}}});
const clear=createRoute({method:'delete',path:base,tags:['project-ai-chat'],request:{params},responses:{200:{description:'个人历史已清空',content:{'application/json':{schema:apiEnvelope(z.object({cleared:z.literal(true)}),'ProjectChatClearedResponse')}}}}});
const operations=createRoute({method:'get',path:base+'/questions/{questionId}/operations',tags:['project-ai-chat'],request:{params:params.extend({questionId:z.string().uuid()}),query},responses:{200:{description:'安全资源操作记录',content:{'application/json':{schema:apiEnvelope(chatOperationsSchema,'ProjectChatOperationsResponse')}}}}});
export function registerProjectChatRoutes(app:OpenAPIHono<AppEnv>){
 app.use('/api/v1/projects/:projectId/ai-chat',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.use('/api/v1/projects/:projectId/ai-chat/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.use('/api/v1/projects/:projectId/ai-chat',requireUser);app.use('/api/v1/projects/:projectId/ai-chat/*',requireUser);
 app.openapi(get,async c=>c.json(apiData(c,await readChat(c.env,c.req.valid('param').projectId,c.get('user')!.id,c.req.valid('query').cursor)),200));
 app.openapi(post,async c=>{const user=c.get('user')!.id,id=c.req.valid('param').projectId,body=c.req.valid('json');await assertChatMember(c.env,id,user);const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId:user,operation:'project.chat:'+id,rawBody:JSON.stringify(body)},async()=>({status:202 as const,body:await enqueueChat(c.env,id,user,body.content)}));return c.json(apiData(c,result.body),202);});
 app.openapi(clear,async c=>{const user=c.get('user')!.id,id=c.req.valid('param').projectId;await assertChatMember(c.env,id,user);const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId:user,operation:'project.chat.clear:'+id,rawBody:'{}'},async()=>({status:200 as const,body:await clearChat(c.env,id,user)}));return c.json(apiData(c,result.body),200);});
 app.openapi(operations,async c=>{const p=c.req.valid('param');return c.json(apiData(c,await readChatOperations(c.env,p.projectId,c.get('user')!.id,p.questionId,c.req.valid('query').cursor)),200);});
}
