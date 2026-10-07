import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { ensureFileProcessing, readFileProcessing } from '../services/file-processing';

const params = z.object({ projectId: z.string().uuid(), fileId: z.string().uuid() });
const view = z.object({
  fileId: z.string().uuid(), lifecycleVersion: z.number().int().positive(),
  sourceId: z.string().uuid().nullable(), sourceVersionId: z.string().uuid().nullable(), jobId: z.string().uuid().nullable(),
  textStatus: z.string(), summaryStatus: z.string(), requirementsStatus: z.string(), error: z.string().nullable(),
  materialIds: z.array(z.string().uuid()), textAvailable: z.boolean(), canProcess: z.boolean(), needsImages: z.number().int().nonnegative(),
});
const path = '/api/v1/projects/{projectId}/files/{fileId}/processing';
const response = apiEnvelope(view, 'FileProcessingResponse');
const get = createRoute({ method: 'get', path, tags: ['files'], summary: '读取文件正文及后续处理阶段', request: { params }, responses: { 200: { description: '真实文件处理状态', content: { 'application/json': { schema: response } } } } });
const post = createRoute({ method: 'post', path, tags: ['files'], summary: '启动或继续文件处理，不重复上传原文件', request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ expectedLifecycleVersion: z.number().int().positive(), retry: z.boolean().optional() }).strict() } } } }, responses: { 200: { description: '处理已启动或当前任务复用', content: { 'application/json': { schema: response } } } } });

export function registerFileProcessingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/files/:fileId/processing', requireUser, requireProjectMember());
  app.openapi(get, async c => {
    c.header('Cache-Control', 'no-store'); const p = c.req.valid('param');
    return c.json(apiData(c, await readFileProcessing(c.env, p.projectId, p.fileId, c.get('user')!.id)), 200);
  });
  app.openapi(post, async c => {
    c.header('Cache-Control', 'no-store'); const p = c.req.valid('param');
    return c.json(apiData(c, await ensureFileProcessing(c.env, p.projectId, p.fileId, c.get('user')!.id, c.req.valid('json'))), 200);
  });
}
