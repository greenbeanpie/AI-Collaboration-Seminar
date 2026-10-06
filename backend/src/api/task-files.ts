import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { parsePaging, nextCursor } from '../core/pagination';
import type { AppEnv } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { readTaskFiles, saveTaskFile } from '../services/task-files';
import { notFound } from '../core/errors';

const params=z.object({projectId:z.string().uuid(),taskId:z.string().uuid()});
const item=z.object({materialId:z.string().uuid(),taskId:z.string().uuid(),fileId:z.string().uuid(),name:z.string(),revision:z.number().int(),versionId:z.string().uuid(),archivedAt:z.string().nullable(),materialArchivedAt:z.string().nullable(),deletedAt:z.string().nullable(),lifecycleVersion:z.number().int(),canManage:z.boolean()});
const path='/api/v1/projects/{projectId}/tasks/{taskId}/files';
const get=createRoute({method:'get',path,tags:['tasks'],request:{params,query:z.object({cursor:z.string().optional(),limit:z.string().optional()})},responses:{200:{description:'任务文件及归档记录',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(item),nextCursor:z.string().nullable()}),'TaskFileListResponse')}}}}});
const post=createRoute({method:'post',path,tags:['tasks'],request:{params,body:{required:true,content:{'application/json':{schema:z.object({fileId:z.string().uuid()}).strict()}}}},responses:{201:{description:'任务文件已登记',content:{'application/json':{schema:apiEnvelope(item,'TaskFileResponse')}}}}});
const put=createRoute({method:'put',path:path+'/{materialId}',tags:['tasks'],request:{params:params.extend({materialId:z.string().uuid()}),body:{required:true,content:{'application/json':{schema:z.object({fileId:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict()}}}},responses:{201:{description:'不可变文件版本已创建',content:{'application/json':{schema:apiEnvelope(item,'TaskFileVersionResponse')}}}}});
export function registerTaskFileRoutes(app:OpenAPIHono<AppEnv>) {
  app.use('/api/v1/projects/:projectId/tasks/:taskId/files',requireUser,requireProjectMember());
  app.use('/api/v1/projects/:projectId/tasks/:taskId/files/*',requireUser,requireProjectMember());
  app.openapi(get,async c=>{
    c.header('Cache-Control','no-store');const p=c.req.valid('param');
    if(!await c.env.DB.prepare('SELECT 1 FROM tasks WHERE id=?1 AND project_id=?2').bind(p.taskId,p.projectId).first()) throw notFound('任务不存在');
    const paging=parsePaging(c.req.valid('query'));
    const rows=await readTaskFiles(c.env,p.projectId,p.taskId,c.get('user')!.id,undefined,paging);
    const items=rows.slice(0,paging.limit),last=items.at(-1);
    return c.json(apiData(c,{items,nextCursor:nextCursor(rows.length>paging.limit,last&&{createdAt:last.createdAt,id:last.materialId})??null}),200);
  });
  app.openapi(post,async c=>{c.header('Cache-Control','no-store');return c.json(apiData(c,await saveTaskFile(c.env,{...c.req.valid('param'),...c.req.valid('json'),actorId:c.get('user')!.id})),201);});
  app.openapi(put,async c=>{c.header('Cache-Control','no-store');return c.json(apiData(c,await saveTaskFile(c.env,{...c.req.valid('param'),...c.req.valid('json'),actorId:c.get('user')!.id})),201);});
}
