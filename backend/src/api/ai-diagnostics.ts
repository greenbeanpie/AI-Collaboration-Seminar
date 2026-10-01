import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { permissionDenied } from '../core/errors';
import { diagnosticEntrySchema, readAiDiagnostics } from '../ai/diagnostics';
import { requireAdmin } from './admin';

const response = apiEnvelope(z.object({ items: z.array(diagnosticEntrySchema), retention: z.object({ maxEntries: z.literal(1000), maxBytes: z.literal(1_000_000), retainedEntries: z.number().int(), retainedBytes: z.number().int() }) }), 'AiDiagnosticsResponse');
const route = createRoute({ method: 'get', path: '/api/v1/admin/ai-diagnostics', tags: ['admin'], summary: '超级管理员读取最后1000条、最多1MB的无内容AI诊断记录', middleware: [requireAdmin], responses: { 200: { content: { 'application/json': { schema: response } }, description: '固定状态和阶段；无业务内容或密钥' } } });

export function registerAiDiagnosticsRoutes(app: OpenAPIHono<AppEnv>) {
  app.openapi(route, async c => {
    // Operator Bearer and ordinary admins intentionally cannot read diagnostics.
    if (c.get('user')?.role !== 'super_admin') throw permissionDenied('需要超级管理员账户查看 AI 诊断日志');
    return c.json(apiData(c, await readAiDiagnostics(c.env)), 200);
  });
}
