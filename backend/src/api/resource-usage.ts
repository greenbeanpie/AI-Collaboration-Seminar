import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv, Env } from '../env';
import { requireUser } from '../core/auth';
import { permissionDenied } from '../core/errors';
import { apiEnvelope } from '../core/openapi';
import { apiData } from '../core/api';
import { aiQuotaDay, releaseAiResourceWithEvidence } from '../services/ai-resource-quota';
import { loadResourcePolicy } from '../services/resource-policy';

const amount=z.object({limit:z.number(),used:z.number(),remaining:z.number()});
const storageAmount=amount.extend({reserved:z.number()});
const schema=z.object({ai:z.object({day:z.string(),timezone:z.literal('Asia/Shanghai'),enabled:z.boolean(),user:amount,project:amount.nullable(),platformDailyLimit:z.number(),globalConcurrencyLimit:z.number()}),storage:z.object({inventoryReady:z.boolean(),user:storageAmount,project:storageAmount.nullable()})});
const remaining=(limit:number,used:number)=>({limit,used,remaining:Math.max(0,limit-used)});
export async function readResourceUsage(env:Pick<Env,'DB'>,userId:string,projectId?:string){
  if(projectId&&!await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId,userId).first())throw permissionDenied('不是项目成员，不能读取此项目用量');
  const policy=await loadResourcePolicy(env),day=aiQuotaDay();
  const count=async(scope:string,id:string)=> (await env.DB.prepare('SELECT calls FROM ai_resource_daily WHERE quota_day=?1 AND scope=?2 AND scope_id=?3').bind(day,scope,id).first<{calls:number}>())?.calls??0;
  const storage=async(column:'user_id'|'project_id',id:string,limit:number)=>{
    const row=await env.DB.prepare(`SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM storage_objects WHERE ${column}=?1) used,(SELECT COALESCE(SUM(bytes),0) FROM storage_reservations WHERE ${column}=?1 AND kind!='delete') reserved`).bind(id).first<{used:number;reserved:number}>();
    const used=row?.used??0,reserved=row?.reserved??0;return {...remaining(limit,used),reserved,remaining:Math.max(0,limit-used-reserved)};
  };
  const [userCalls,projectCalls,userStorage,projectStorage,inventory]=await Promise.all([count('user',userId),projectId?count('project',projectId):Promise.resolve(null),storage('user_id',userId,policy.userStorageBytes),projectId?storage('project_id',projectId,policy.projectStorageBytes):Promise.resolve(null),env.DB.prepare('SELECT ready,external_checked_at FROM storage_inventory_state WHERE id=1').first<{ready:number;external_checked_at:string|null}>()]);
  return {ai:{day,timezone:'Asia/Shanghai' as const,enabled:policy.aiEnabled,user:remaining(policy.userDailyCalls,userCalls),project:projectCalls===null?null:remaining(policy.projectDailyCalls,projectCalls),platformDailyLimit:policy.platformDailyCalls,globalConcurrencyLimit:policy.globalConcurrency},storage:{inventoryReady:inventory?.ready===1,user:userStorage,project:projectStorage}};
}
export function registerResourceUsageRoutes(app:OpenAPIHono<AppEnv>){
  app.use('/api/v1/resource-usage',requireUser);
  app.openapi(createRoute({method:'get',path:'/api/v1/resource-usage',tags:['resources'],summary:'当前账户与有权项目的资源用量',request:{query:z.object({projectId:z.string().uuid().optional()})},responses:{200:{description:'资源用量（不含其他用户明细）',content:{'application/json':{schema:apiEnvelope(schema,'ResourceUsageResponse')}}}}}),async c=>{c.header('Cache-Control','private, no-store');return c.json(apiData(c,await readResourceUsage(c.env,c.get('user')!.id,c.req.valid('query').projectId)),200);});
  app.use('/api/v1/admin/ai-resource-dispatches',requireUser);
  app.use('/api/v1/admin/ai-resource-dispatches/*',requireUser);
  const requireOperator=(c:{get:(name:'user')=>AppEnv['Variables']['user']})=>{const user=c.get('user');if(user?.role!=='super_admin')throw permissionDenied('需要超级管理员登录会话核对，运维令牌不能代替操作者');return user;};
  const held=z.object({id:z.string(),user_id:z.string().nullable(),project_id:z.string().nullable(),operation:z.string(),target_id:z.string().nullable(),model:z.string().nullable(),status:z.string(),quota_day:z.string(),created_at:z.string(),lease_until:z.string().nullable()});
  app.openapi(createRoute({method:'get',path:'/api/v1/admin/ai-resource-dispatches',tags:['admin'],summary:'核对仍占用并发的模型请求',responses:{200:{description:'最多100个待核对请求，不含提示正文或密钥',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(held)}),'AiResourceHeldResponse')}}}}}),async c=>{requireOperator(c);c.header('Cache-Control','private, no-store');const rows=await c.env.DB.prepare("SELECT id,user_id,project_id,operation,target_id,model,status,quota_day,created_at,lease_until FROM ai_resource_dispatches WHERE status IN('claimed','uncertain') AND (lease_until IS NULL OR lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY created_at,id LIMIT 100").all<z.infer<typeof held>>();return c.json(apiData(c,{items:rows.results}),200);});
  app.openapi(createRoute({method:'post',path:'/api/v1/admin/ai-resource-dispatches/{id}/release',tags:['admin'],summary:'供应商确认已结束后审计释放并发，不退当日计数',request:{params:z.object({id:z.string().uuid()}),body:{content:{'application/json':{schema:z.object({providerConfirmedEnded:z.literal(true),reason:z.string().trim().min(10).max(500)}).strict()}},required:true}},responses:{200:{description:'已核对并释放',content:{'application/json':{schema:apiEnvelope(z.object({id:z.string(),status:z.literal('completed')}),'AiResourceReleaseResponse')}}}}}),async c=>{const user=requireOperator(c),body=c.req.valid('json');return c.json(apiData(c,await releaseAiResourceWithEvidence(c.env,c.req.valid('param').id,user.id,body.reason)),200);});
}
