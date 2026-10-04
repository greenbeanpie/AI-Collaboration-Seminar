import { createRoute,OpenAPIHono,z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser,requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { withIdempotency } from '../services/idempotency';
import { taskAssistancePlanSchema,readTaskAssistancePlan,enqueueTaskAssistancePlan } from '../services/task-assistance-plan';
export function registerTaskAssistancePlanRoutes(app:OpenAPIHono<AppEnv>):void{
 const path='/api/v1/projects/{projectId}/collaboration/tasks/{taskId}/assistance-plan';
 app.use('/api/v1/projects/:projectId/collaboration/tasks/:taskId/assistance-plan',requireUser,requireProjectMember());
 const params=z.object({projectId:z.string().uuid(),taskId:z.string().uuid()});
 const responses={200:{description:'任务辅助计划及生成状态',content:{'application/json':{schema:apiEnvelope(taskAssistancePlanSchema,'TaskAssistancePlanResponse')}}}};
 app.openapi(createRoute({method:'get',path,tags:['collaboration'],summary:'读取任务辅助计划',request:{params},responses}),async c=>{const {projectId,taskId}=c.req.valid('param');return c.json(apiData(c,await readTaskAssistancePlan(c.env,projectId,taskId,c.get('user')!.id)),200);});
 app.openapi(createRoute({method:'post',path,tags:['collaboration'],summary:'手动生成任务辅助计划',request:{params,body:{required:true,content:{'application/json':{schema:z.object({expectedRevision:z.number().int().positive(),regenerate:z.boolean().optional()}).strict()}}}},responses}),async c=>{
 const {projectId,taskId}=c.req.valid('param'),body=c.req.valid('json'),userId=c.get('user')!.id;
 const result=await withIdempotency(c.env,{required:true,key:c.req.header('idempotency-key'),userId,operation:'collaboration.assistance-plan',rawBody:JSON.stringify({projectId,taskId,...body})},async()=>({status:200 as const,body:await enqueueTaskAssistancePlan(c.env,projectId,taskId,userId,body.expectedRevision,body.regenerate)}));
 return c.json(apiData(c,result.body),200);
 });
}
