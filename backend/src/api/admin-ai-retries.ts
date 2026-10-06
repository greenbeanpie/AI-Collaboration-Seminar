import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { permissionDenied } from '../core/errors';
import { requireAdmin } from './admin';
import { readAdminAiRetries, enqueueAdminAiRetries, clearPendingAdminAiRetries } from '../services/admin-ai-retries';
const batch=z.object({batchId:z.string().uuid(),status:z.enum(['queued','running','completed']),total:z.number(),pending:z.number(),queued:z.number(),skipped:z.number(),createdAt:z.string(),updatedAt:z.string(),skipReasons:z.array(z.object({reason:z.string(),count:z.number()}))});
const get=createRoute({method:'get',path:'/api/v1/admin/ai-retries',tags:['admin'],middleware:[requireAdmin],summary:'读取失败 AI 请求与批量重试排队状态',responses:{200:{description:'无业务内容的重试统计',content:{'application/json':{schema:apiEnvelope(z.object({failedCount:z.number(),pendingRetryCount:z.number(),activeBatch:batch.nullable(),latestBatch:batch.nullable()}),'AdminAiRetries')}}}}});
const post=createRoute({method:'post',path:'/api/v1/admin/ai-retries',tags:['admin'],middleware:[requireAdmin],summary:'快照并排队所有当前失败 AI 请求',request:{body:{content:{'application/json':{schema:z.object({idempotencyKey:z.string().uuid()}).strict()}}}},responses:{202:{description:'快照批次已持久排队',content:{'application/json':{schema:apiEnvelope(z.object({batch,replayed:z.boolean()}),'AdminAiRetryBatch')}}}}});
const clear=createRoute({method:'delete',path:'/api/v1/admin/ai-retries',tags:['admin'],middleware:[requireAdmin],summary:'清除尚未开始的失败 AI 请求重试记录',responses:{200:{description:'仅删除 pending 队列项；原失败作业、日志和已领取条目保留',content:{'application/json':{schema:apiEnvelope(z.object({deletedItems:z.number().int().nonnegative(),completedBatches:z.number().int().nonnegative()}),'AdminAiRetriesCleared')}}}}});
export function registerAdminAiRetryRoutes(app:OpenAPIHono<AppEnv>){
 app.openapi(get,async c=>c.json(apiData(c,await readAdminAiRetries(c.env)),200));
 app.openapi(post,async c=>{if(c.get('user')&&c.get('user')!.role!=='super_admin')throw permissionDenied('需要超级管理员权限');return c.json(apiData(c,await enqueueAdminAiRetries(c.env,c.req.valid('json').idempotencyKey,c.get('user')?.id??null)),202);});
 app.openapi(clear,async c=>{if(c.get('user')?.role!=='super_admin')throw permissionDenied('需要超级管理员权限');return c.json(apiData(c,await clearPendingAdminAiRetries(c.env)),200);});
}
