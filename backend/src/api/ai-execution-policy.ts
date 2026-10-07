import {createRoute,OpenAPIHono,z} from '@hono/zod-openapi';
import type {AppEnv} from '../env';
import {apiData} from '../core/api';
import {apiEnvelope,apiErrorEnvelope} from '../core/openapi';
import {permissionDenied} from '../core/errors';
import {requireAdmin} from './admin';
import {loadExecutionPolicy,saveExecutionPolicy} from '../services/ai-execution-control';
export {executionSchema} from '../services/ai-execution-control';
const policySchema=z.object({version:z.number().int().positive(),maxModelCalls:z.number().int().min(1).max(10000)});
const response=apiEnvelope(policySchema,'AiExecutionPolicyResponse');
export function registerAiExecutionPolicyRoutes(app:OpenAPIHono<AppEnv>){
 app.use('/api/v1/admin/ai-execution-policy',requireAdmin,async(c,next)=>{const user=c.get('user');if(user && user.role!=='super_admin')throw permissionDenied('需要超级管理员权限');await next();});
 app.openapi(createRoute({method:'get',path:'/api/v1/admin/ai-execution-policy',tags:['admin'],summary:'读取后台 AI 执行策略',responses:{200:{description:'独立执行策略',content:{'application/json':{schema:response}}},403:{description:'需要超级管理员权限',content:{'application/json':{schema:apiErrorEnvelope}}}}}),async c=>c.json(apiData(c,await loadExecutionPolicy(c.env)),200));
 app.openapi(createRoute({method:'put',path:'/api/v1/admin/ai-execution-policy',tags:['admin'],summary:'更新后台 AI 窗口调用上限',request:{body:{content:{'application/json':{schema:z.object({expectedVersion:z.number().int().positive(),maxModelCalls:z.number().int().min(1).max(10000)}).strict()}}}},responses:{200:{description:'已保存并记录审计',content:{'application/json':{schema:response}}},409:{description:'策略版本已变化',content:{'application/json':{schema:apiErrorEnvelope}}}}}),async c=>{const input=c.req.valid('json');return c.json(apiData(c,await saveExecutionPolicy(c.env,input.expectedVersion,input.maxModelCalls,c.get('user')?.id??null)),200);});
}
