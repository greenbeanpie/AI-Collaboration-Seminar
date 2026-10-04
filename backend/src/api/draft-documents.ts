import { createRoute,OpenAPIHono,z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { beginDraftUpload,draftUploadStatus,uploadDraftPart,completeDraftUpload,cancelDraftUpload,importDraftBlocks,finishDraftImport,draftBlockSchema } from '../services/draft-documents';
const path='/api/v1/creation-drafts/{draftId}/files/{fileId}';
const params=z.object({draftId:z.string().uuid(),fileId:z.string().uuid()});
const data=z.record(z.string(),z.unknown()),response=apiEnvelope(data,'DraftDocumentOperationResponse');
const json=<T extends z.ZodType>(schema:T)=>({required:true,content:{'application/json':{schema}}});
const responses={200:{description:'草稿文档操作结果',content:{'application/json':{schema:response}}}};
export function registerDraftDocumentRoutes(app:OpenAPIHono<AppEnv>) {
 app.openapi(createRoute({method:'post',path:path+'/multipart',request:{params,body:json(z.object({expectedRevision:z.number().int().positive(),name:z.string().min(1).max(255),sizeBytes:z.number().int().positive()}))},responses}),async c=>{const p=c.req.valid('param'),b=c.req.valid('json');return c.json(apiData(c,data.parse(await beginDraftUpload(c.env,p.draftId,c.get('user')!.id,p.fileId,b.name,b.sizeBytes,b.expectedRevision))),200);});
 app.openapi(createRoute({method:'get',path:path+'/multipart',request:{params},responses}),async c=>{const p=c.req.valid('param');return c.json(apiData(c,data.parse(await draftUploadStatus(c.env,p.draftId,c.get('user')!.id,p.fileId))),200);});
 app.openapi(createRoute({method:'put',path:path+'/multipart/{partNumber}',request:{params:params.extend({partNumber:z.coerce.number().int().min(1).max(10000)})},responses}),async c=>{const p=c.req.valid('param');return c.json(apiData(c,data.parse(await uploadDraftPart(c.env,p.draftId,c.get('user')!.id,p.fileId,p.partNumber,c.req.raw.body,Number(c.req.header('content-length')??'0')))),200);});
 app.openapi(createRoute({method:'post',path:path+'/multipart/complete',request:{params},responses}),async c=>{const p=c.req.valid('param');return c.json(apiData(c,data.parse(await completeDraftUpload(c.env,p.draftId,c.get('user')!.id,p.fileId))),200);});
 app.openapi(createRoute({method:'delete',path:path+'/multipart',request:{params},responses}),async c=>{const p=c.req.valid('param');return c.json(apiData(c,data.parse(await cancelDraftUpload(c.env,p.draftId,c.get('user')!.id,p.fileId))),200);});
 app.openapi(createRoute({method:'post',path:path+'/imports',request:{params,body:json(z.object({expectedRevision:z.number().int().positive(),blocks:z.array(draftBlockSchema).min(1).max(10)}))},responses}),async c=>{const p=c.req.valid('param'),b=c.req.valid('json');return c.json(apiData(c,data.parse(await importDraftBlocks(c.env,p.draftId,c.get('user')!.id,p.fileId,b.expectedRevision,b.blocks))),200);});
 app.openapi(createRoute({method:'post',path:path+'/imports/complete',request:{params,body:json(z.object({expectedRevision:z.number().int().positive(),blocks:z.number().int().nonnegative(),status:z.enum(['complete','partial']),warnings:z.array(z.string().max(500)).max(100).default([])}))},responses}),async c=>{const p=c.req.valid('param'),b=c.req.valid('json');return c.json(apiData(c,data.parse(await finishDraftImport(c.env,p.draftId,c.get('user')!.id,p.fileId,b.expectedRevision,b.blocks,b.status,b.warnings))),200);});
}
