import {createRoute,OpenAPIHono,z} from '@hono/zod-openapi';
import type {AppEnv} from '../env';
import {apiData} from '../core/api';
import {apiEnvelope,apiErrorEnvelope} from '../core/openapi';
import {permissionDenied} from '../core/errors';
import {requireAdmin} from './admin';
import {loadResourcePolicy,saveResourcePolicy,resourcePolicyFields,resourcePolicySchema} from '../services/resource-policy';
export function registerResourcePolicyRoutes(app:OpenAPIHono<AppEnv>){
 app.use('/api/v1/admin/resource-policy',requireAdmin,async(c,next)=>{if(c.get('user')&&c.get('user')!.role!=='super_admin')throw permissionDenied('需要超级管理员权限');c.header('Cache-Control','no-store');await next();});
 const responses={200:{description:'资源策略',content:{'application/json':{schema:apiEnvelope(resourcePolicySchema,'ResourcePolicyResponse')}}},403:{description:'需要超级管理员权限',content:{'application/json':{schema:apiErrorEnvelope}}}};
 app.openapi(createRoute({method:'get',path:'/api/v1/admin/resource-policy',tags:['admin'],responses}),async c=>c.json(apiData(c,await loadResourcePolicy(c.env)),200));
 app.openapi(createRoute({method:'put',path:'/api/v1/admin/resource-policy',tags:['admin'],request:{body:{required:true,content:{'application/json':{schema:resourcePolicyFields.extend({expectedVersion:z.number().int().positive()}).strict()}}}},responses:{...responses,409:{description:'版本已变化',content:{'application/json':{schema:apiErrorEnvelope}}}}}),async c=>{const {expectedVersion,...policy}=c.req.valid('json');return c.json(apiData(c,await saveResourcePolicy(c.env,expectedVersion,policy,c.get('user')?.id??null)),200);});
}
