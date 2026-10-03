import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { apiData } from '../core/api';
import { validationFailed } from '../core/errors';
import { withIdempotency } from '../services/idempotency';

export function syncWriteAllowed(tail: string, method: string): boolean {
  return (method === 'PUT' && /^materials\/[a-zA-Z0-9-]+$/.test(tail))
    || (method === 'PATCH' && /^(?:collaboration\/)?tasks\/[a-zA-Z0-9-]+$/.test(tail))
    || (method === 'POST' && /^(?:tasks|comments|collaboration\/tasks|(?:collaboration\/)?tasks\/[a-zA-Z0-9-]+\/(?:claim|submissions))$/.test(tail));
}
const route = createRoute({
  method: 'post', path: '/api/v1/projects/{projectId}/offline-sync', tags: ['offline'],
  summary: '同步单个离线操作；沿用原接口权限、版本校验并保存幂等响应',
  middleware: [requireUser, requireProjectMember()] as const,
  request: { params: z.object({ projectId: z.string().uuid() }), body: { required: true, content: { 'application/json': { schema: z.object({
    method: z.enum(['POST', 'PUT', 'PATCH']), tail: z.string().min(1).max(200), body: z.record(z.string(), z.unknown()),
  }).strict() } } } },
  responses: { 200: { description: '原操作结果', content: { 'application/json': { schema: apiEnvelope(z.unknown(), 'OfflineSyncResponse') } } },
    400: { description: '无效操作', content: { 'application/json': { schema: apiErrorEnvelope } } },
    409: { description: '版本或幂等冲突', content: { 'application/json': { schema: apiErrorEnvelope } } } },
});
export function registerOfflineSyncRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async c => {
    const input = c.req.valid('json'), projectId = c.req.valid('param').projectId;
    if (!syncWriteAllowed(input.tail, input.method)) throw validationFailed('该操作不能通过离线同步执行');
    const key = c.req.header('Idempotency-Key');
    const result = await withIdempotency(c.env, { key, userId: c.get('user')!.id, operation: `offline-sync:${projectId}`, rawBody: JSON.stringify(input), required: true }, async () => {
      const headers = new Headers(c.req.raw.headers);
      headers.set('Content-Type', 'application/json');
      // Existing target handlers still own validation, project permissions and optimistic locks.
      const request = new Request(new URL(`/api/v1/projects/${projectId}/${input.tail}`, c.req.url), { method: input.method, headers, body: JSON.stringify(input.body) });
      const response = await app.fetch(request, c.env, c.executionCtx);
      return { status: response.status, body: await response.json() as { data?: unknown; error?: unknown } };
    });
    c.header('Cache-Control', 'no-store');
    if (result.status >= 400) return c.json(apiErrorEnvelope.parse(result.body), result.status as 400);
    return c.json(apiData(c, result.body.data), 200);
  });
}
