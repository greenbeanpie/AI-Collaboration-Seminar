import { withIdempotency } from '../services/idempotency';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { createFileInit, readFileContent, storeFileContent } from '../services/files';

const paramsProject = z.object({ projectId: z.string().uuid().openapi({ description: '项目 ID' }) });
const paramsFile = paramsProject.extend({ fileId: z.string().uuid() });

const initBody = z.object({
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
  summary: '上传文件内容（二进制，≤10MiB，按实际上传字节校验）',
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

export function registerFileRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/files', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/files/:fileId/content', requireUser, requireProjectMember());

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
      });
      return { status: 201 as const, body: { fileId: file.fileId, upload: { method: 'PUT' as const, url: file.uploadUrl } } };
    });
    return c.json(apiData(c, result.body), result.status);
  });

  app.openapi(contentRoute, async (c) => {
    const { projectId, fileId } = c.req.valid('param');
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    const stored = await storeFileContent(c.env, { projectId, fileId, bytes });
    return c.json(
      apiData(c, { fileId, sizeBytes: stored.sizeBytes, sha256: stored.sha256, mimeDetected: stored.mimeDetected }),
      201,
    );
  });

  app.openapi(downloadRoute, async (c) => {
    const { projectId, fileId } = c.req.valid('param');
    const file = await readFileContent(c.env, { projectId, fileId });
    return c.body(file.body, 200, { 'content-type': file.mime });
  });
}
