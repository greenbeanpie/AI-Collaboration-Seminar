import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { permissionDenied } from '../core/errors';
import { diagnosticEntrySchema, readAiDiagnostics } from '../ai/diagnostics';
import { requireAdmin } from './admin';

const response = apiEnvelope(z.object({ items: z.array(diagnosticEntrySchema), retention: z.object({ maxEntries: z.literal(1000), maxBytes: z.literal(1_000_000), retainedEntries: z.number().int(), retainedBytes: z.number().int() }) }), 'AiDiagnosticsResponse');
const clearedResponse = apiEnvelope(z.object({ deleted: z.number().int().nonnegative() }), 'AiDiagnosticsClearedResponse');
const route = createRoute({ method: 'get', path: '/api/v1/admin/ai-diagnostics', tags: ['admin'], summary: '超级管理员读取最后1000条、最多1MB的AI诊断记录', middleware: [requireAdmin], responses: { 200: { content: { 'application/json': { schema: response } }, description: '固定状态、阶段和错误原因；不包含请求内容或密钥' } } });
const clearRoute = createRoute({
  method: 'delete', path: '/api/v1/admin/ai-diagnostics', tags: ['admin'],
  summary: '超级管理员清空AI诊断记录', middleware: [requireAdmin],
  responses: { 200: { content: { 'application/json': { schema: clearedResponse } }, description: '记录已清空' } },
});

export function registerAiDiagnosticsRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async c => {
    // Operator Bearer and ordinary admins intentionally cannot read diagnostics.
    if (c.get('user')?.role !== 'super_admin') throw permissionDenied('需要超级管理员账户查看 AI 诊断日志');
    return c.json(apiData(c, await readAiDiagnostics(c.env)), 200);
  });
  app.openapi(clearRoute, async c => {
    if (c.get('user')?.role !== 'super_admin') throw permissionDenied('需要超级管理员账户清空 AI 诊断日志');
    const result = await c.env.DB.prepare('DELETE FROM ai_diagnostics').run();
    return c.json(apiData(c, { deleted: result.meta.changes ?? 0 }), 200);
  });
}
