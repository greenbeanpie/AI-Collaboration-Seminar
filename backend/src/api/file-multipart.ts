import { OpenAPIHono,createRoute,z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser,requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { validationFailed } from '../core/errors';
import { beginMultipart,multipartStatus,putMultipartPart,completeMultipart,abortMultipart } from '../services/file-multipart';

const base='/api/v1/projects/{projectId}/files/{fileId}/uploads';
const params=z.object({projectId:z.string().uuid(),fileId:z.string().uuid()});
const session=params.extend({sessionId:z.string().uuid()});
const response=apiEnvelope(z.object({sessionId:z.string(),partBytes:z.number()}),'MultipartInitResponse');
export function registerMultipartRoutes(app:OpenAPIHono<AppEnv>) {
 app.use('/api/v1/projects/:projectId/files/:fileId/uploads',requireUser,requireProjectMember());
 app.use('/api/v1/projects/:projectId/files/:fileId/uploads/*',requireUser,requireProjectMember());
 app.openapi(createRoute({method:'post',path:base,tags:['files'],request:{params,body:{content:{'application/json':{schema:z.object({sizeBytes:z.number().int().positive()}).strict()}},required:true}},responses:{201:{description:'开始或恢复分片上传',content:{'application/json':{schema:response}}}}}),async c=>{const p=c.req.valid('param');return c.json(apiData(c,await beginMultipart(c.env,p.projectId,p.fileId,c.get('user')!.id,c.req.valid('json').sizeBytes)),201);});
 const envelope=apiEnvelope(z.record(z.string(),z.unknown()),'MultipartOperationResponse');
 app.openapi(createRoute({method:'get',path:base+'/{sessionId}',tags:['files'],request:{params:session},responses:{200:{description:'上传状态',content:{'application/json':{schema:envelope}}}}}),async c=>{const p=c.req.valid('param');return c.json(apiData(c,await multipartStatus(c.env,p.projectId,p.fileId,c.get('user')!.id,p.sessionId)),200);});
 app.openapi(createRoute({method:'put',path:base+'/{sessionId}/parts/{partNumber}',tags:['files'],request:{params:session.extend({partNumber:z.string().regex(/^[1-9]\d*$/)}),headers:z.object({'x-part-size':z.string().regex(/^\d+$/)})},responses:{201:{description:'分片已接收',content:{'application/json':{schema:envelope}}}}}),async c=>{const p=c.req.valid('param');if(!c.req.raw.body)throw validationFailed('分片不能为空');return c.json(apiData(c,await putMultipartPart(c.env,p.projectId,p.fileId,c.get('user')!.id,p.sessionId,Number(p.partNumber),c.req.raw.body,Number(c.req.header('x-part-size')))),201);});
 for(const operation of ['complete','abort'] as const)app.openapi(createRoute({method:'post',path:base+'/{sessionId}/'+operation,tags:['files'],request:{params:session},responses:{200:{description:operation,content:{'application/json':{schema:envelope}}}}}),async c=>{const p=c.req.valid('param');const fn=operation==='complete'?completeMultipart:abortMultipart;return c.json(apiData(c,await fn(c.env,p.projectId,p.fileId,c.get('user')!.id,p.sessionId)),200);});
}
