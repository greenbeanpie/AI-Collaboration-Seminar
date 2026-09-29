import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { getJob, tryDispatchJob } from '../services/jobs';

const jobParams = z.object({ jobId: z.string().uuid() });

const jobResponse = apiEnvelope(
  z.object({
    jobId: z.string().uuid(),
    kind: z.string(),
    status: z.enum(['queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled']),
    result: z.unknown().nullable(),
    error: z.unknown().nullable(),
    attempts: z.number().int(),
    createdAt: z.string(),
  }),
  'JobResponse',
);

const retryResponse = apiEnvelope(z.object({ jobId: z.string().uuid() }), 'JobRetryResponse');

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/jobs/{jobId}',
  tags: ['jobs'],
  summary: '查询异步任务状态（前端 2s→10s 退避轮询）',
  request: { params: jobParams },
  responses: { 200: { content: { 'application/json': { schema: jobResponse } }, description: '任务状态' } },
});

const retryRoute = createRoute({
  method: 'post',
  path: '/api/v1/jobs/{jobId}/retry',
  tags: ['jobs'],
  summary: '重试失败任务（终态成功/取消不可重试）',
  request: { params: jobParams },
  responses: {
    202: { content: { 'application/json': { schema: retryResponse } }, description: '已重新排队' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '终态不可重试' },
  },
});

export function registerJobRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/jobs/:jobId', requireUser);

  app.openapi(getRoute, async (c) => {
    const job = await getJob(c.env, c.req.valid('param').jobId);
    // 项目任务仅项目成员可见
    if (job.project_id) {
      const member = await c.env.DB.prepare('SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2')
        .bind(job.project_id, c.get('user')!.id)
        .first<{ role: string }>();
      if (!member) throw permissionDenied('不是项目成员');
    }
    return c.json(
      apiData(c, {
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        result: job.result_json ? (JSON.parse(job.result_json) as unknown) : null,
        error: job.error_json ? (JSON.parse(job.error_json) as unknown) : null,
        attempts: job.attempts,
        createdAt: job.created_at,
      }),
      200,
    );
  });

  app.openapi(retryRoute, async (c) => {
    const job = await getJob(c.env, c.req.valid('param').jobId);
    if (job.project_id) {
      const member = await c.env.DB.prepare('SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2')
        .bind(job.project_id, c.get('user')!.id)
        .first<{ role: string }>();
      if (!member) throw permissionDenied('不是项目成员');
    }
    if (job.status !== 'failed') throw invalidState('仅失败任务可重试');
    const input = JSON.parse(job.input_json) as Record<string, unknown>;
    const newJobId = newId();
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, 0, ?5, ?6, ?6)",
      ).bind(newJobId, job.project_id, job.kind, JSON.stringify(input), c.get('user')!.id, now),
      c.env.DB.prepare(
        "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, 0, ?4, ?4)",
      ).bind(newId(), newJobId, now, now),
    ]);
    await tryDispatchJob(c.env, newJobId);
    return c.json(apiData(c, { jobId: newJobId }), 202);
  });
}
