import { contributorSchema, fileContributors } from '../services/file-contributors';
import { withIdempotency } from '../services/idempotency';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { AppError } from '../core/errors';
import { LIMITS } from '../core/limits';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { nextCursor, parsePaging } from '../core/pagination';
import { changeFileLifecycle } from '../services/file-lifecycle';
import { createFileInit, readFileContent, storeFileContent, readBoundedUpload, uploadLimit } from '../services/files';
import { notFound } from '../core/errors';

const paramsProject = z.object({ projectId: z.string().uuid().openapi({ description: '项目 ID' }) });
const paramsFile = paramsProject.extend({ fileId: z.string().uuid() });

const initBody = z.object({
  contributorIds: z.array(z.string().uuid()).min(1).optional(),
  derivedFromFileId: z.string().uuid().optional(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(127).optional(),
});

const initResponse = apiEnvelope(
  z.object({
    fileId: z.string().uuid(),
    upload: z.object({ method: z.literal('PUT'), url: z.string() }),
  }),
  'FileInitResponse',
);

const storedResponse = apiEnvelope(
  z.object({
    fileId: z.string().uuid(),
    sizeBytes: z.number().int(),
    sha256: z.string(),
    mimeDetected: z.string(),
  }),
  'FileStoredResponse',
);

const initRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/files',
  tags: ['files'],
  summary: '创建文件记录，获取上传地址（服务端分配 R2 key）',
  request: { params: paramsProject, body: { content: { 'application/json': { schema: initBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: initResponse } }, description: '已创建待上传文件' },
  },
});

const contentRoute = createRoute({
  method: 'put',
  path: '/api/v1/projects/{projectId}/files/{fileId}/content',
  tags: ['files'],
  summary: '上传文件内容（二进制，文档≤10MiB，音视频≤50MiB，按实际字节校验）',
  request: { params: paramsFile },
  responses: {
    201: { content: { 'application/json': { schema: storedResponse } }, description: '校验通过并已存储' },
    413: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '超过大小限制' },
    415: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '文件类型校验未通过' },
  },
});

const downloadRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/files/{fileId}/content',
  tags: ['files'],
  summary: '下载文件内容（需项目成员权限；R2 不公开）',
  request: { params: paramsFile },
  responses: {
    200: {
      content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
      description: '文件字节流',
    },
  },
});

const fileListResponse = apiEnvelope(z.object({ items:z.array(z.object({
  fileId:z.string().uuid(),name:z.string(),status:z.enum(['pending','available','quarantined','discarded']),
  sizeBytes:z.number().int().nullable(),createdAt:z.string(),deletedAt:z.string().nullable(),lifecycleVersion:z.number().int(),
  contributors:z.array(contributorSchema).optional(),uploaderUserId:z.string().uuid().optional(),canDelete:z.boolean(),sourceIds:z.array(z.string().uuid()),
})),nextCursor:z.string().nullable()}),'FileListResponse');
const lifecycleBody=z.object({expectedLifecycleVersion:z.number().int().positive()}).strict();
const lifecycleResponse=apiEnvelope(z.object({fileId:z.string().uuid(),deletedAt:z.string().nullable(),lifecycleVersion:z.number().int(),affectedSourceIds:z.array(z.string().uuid())}),'FileLifecycleResponse');
const listRoute=createRoute({method:'get',path:'/api/v1/projects/{projectId}/files',tags:['files'],summary:'文件库和回收站（含未完成上传）',
  request:{params:paramsProject,query:z.object({deleted:z.enum(['true','false']).optional(),cursor:z.string().optional(),limit:z.string().optional()})},
  responses:{200:{description:'文件列表',content:{'application/json':{schema:fileListResponse}}}}});
const deleteRoute=createRoute({method:'delete',path:'/api/v1/projects/{projectId}/files/{fileId}',tags:['files'],summary:'移入回收站并取消相关来源任务，保留原文件和历史',
  request:{params:paramsFile,body:{required:true,content:{'application/json':{schema:lifecycleBody}}}},
  responses:{200:{description:'已移入回收站',content:{'application/json':{schema:lifecycleResponse}}},409:{description:'生命周期变化',content:{'application/json':{schema:apiErrorEnvelope}}}}});
const restoreRoute=createRoute({method:'post',path:'/api/v1/projects/{projectId}/files/{fileId}/restore',tags:['files'],summary:'恢复文件和关联来源，不自动启动 AI',
  request:{params:paramsFile,body:{required:true,content:{'application/json':{schema:lifecycleBody}}}},
  responses:{200:{description:'已恢复',content:{'application/json':{schema:lifecycleResponse}}},409:{description:'生命周期变化',content:{'application/json':{schema:apiErrorEnvelope}}}}});

export function registerFileRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/files', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/files/*', requireUser, requireProjectMember());

  app.openapi(listRoute,async c=>{
    c.header('Cache-Control','no-store');
    const member=c.get('member')!;const query=c.req.valid('query');const {limit,cursor}=parsePaging(query);
    const rows=await c.env.DB.prepare(`SELECT id,original_name,ext,status,size_bytes,created_at,deleted_at,lifecycle_version,uploader_user_id
      FROM files WHERE project_id=?1 AND (deleted_at IS NOT NULL)=?2
        AND (?3 IS NULL OR created_at<?3 OR (created_at=?3 AND id<?4)) ORDER BY created_at DESC,id DESC LIMIT ?5`)
      .bind(member.projectId,query.deleted==='true'?1:0,cursor?.createdAt??null,cursor?.id??null,limit+1)
      .all<{id:string;original_name:string|null;ext:string;status:'pending'|'available'|'quarantined'|'discarded';size_bytes:number|null;created_at:string;deleted_at:string|null;lifecycle_version:number;uploader_user_id:string}>();
    const items=await Promise.all(rows.results.slice(0,limit).map(async r=>{
      const sources=await c.env.DB.prepare(`SELECT DISTINCT v.source_id FROM source_versions v WHERE v.project_id=?1 AND
        (v.file_id=?2 OR EXISTS(SELECT 1 FROM source_pages page WHERE page.source_version_id=v.id AND page.image_file_id=?2))`).bind(member.projectId,r.id).all<{source_id:string}>();
      return {contributors:await fileContributors(c.env,member.projectId,r.id),uploaderUserId:r.uploader_user_id,fileId:r.id,name:r.original_name??`文件 ${r.id.slice(0,8)}${r.ext}`,status:r.status,sizeBytes:r.size_bytes,createdAt:r.created_at,deletedAt:r.deleted_at,lifecycleVersion:r.lifecycle_version,
        canDelete:member.permissions.resourceManage||r.uploader_user_id===c.get('user')!.id,sourceIds:sources.results.map(source=>source.source_id)};
    }));
    const last=items.at(-1);return c.json(apiData(c,{items,nextCursor:nextCursor(rows.results.length>limit,last&&{createdAt:last.createdAt,id:last.fileId})??null}),200);
  });
  app.openapi(deleteRoute,async c=>{
    c.header('Cache-Control','no-store');const p=c.req.valid('param');
    const result=await changeFileLifecycle(c.env,{...p,actorId:c.get('user')!.id,expectedLifecycleVersion:c.req.valid('json').expectedLifecycleVersion,restore:false});
    return c.json(apiData(c,result),200);
  });
  app.openapi(restoreRoute,async c=>{
    c.header('Cache-Control','no-store');const p=c.req.valid('param');
    const result=await changeFileLifecycle(c.env,{...p,actorId:c.get('user')!.id,expectedLifecycleVersion:c.req.valid('json').expectedLifecycleVersion,restore:true});
    return c.json(apiData(c,result),200);
  });

  app.openapi(initRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const result = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId: user.id, operation: 'files.init', rawBody: JSON.stringify({ projectId: member.projectId, ...body }) }, async () => {
      const file = await createFileInit(c.env, {
        projectId: member.projectId,
        uploaderUserId: user.id,
        fileName: body.fileName,
        contentType: body.contentType,
        contributorIds: body.contributorIds,
        derivedFromFileId: body.derivedFromFileId,
      });
      return { status: 201 as const, body: { fileId: file.fileId, upload: { method: 'PUT' as const, url: file.uploadUrl } } };
    });
    return c.json(apiData(c, result.body), result.status);
  });

  app.openapi(contentRoute, async (c) => {
    const { projectId, fileId } = c.req.valid('param');
    const file=await c.env.DB.prepare('SELECT ext FROM files WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL').bind(fileId,projectId).first<{ext:string}>();
    if(!file)throw notFound('文件不存在');
    const fileLimit=uploadLimit(file.ext);
    let bytes:Uint8Array;
    try { bytes=await readBoundedUpload(c.req.raw.body,fileLimit ?? LIMITS.recommendedCloudFileBytes); }
    catch(error) {
      if(fileLimit===null&&error instanceof AppError&&error.code==='FILE_TOO_LARGE')throw new AppError('FILE_TOO_LARGE','单次快捷上传超过10 MiB，请改用分片上传；文件总大小没有应用上限',413,false);
      throw error;
    }
    const stored = await storeFileContent(c.env, { projectId, fileId, bytes });
    return c.json(
      apiData(c, { fileId, sizeBytes: stored.sizeBytes, sha256: stored.sha256, mimeDetected: stored.mimeDetected }),
      201,
    );
  });

  app.openapi(downloadRoute, async (c) => {
    const { projectId, fileId } = c.req.valid('param');
    const file = await readFileContent(c.env, { projectId, fileId, range:c.req.header('range') });
    return new Response(file.body,{status:file.status,headers:{'content-type':file.mime,...file.headers,'cache-control':'no-store','x-request-id':c.get('requestId')??crypto.randomUUID()}});
  });
}
