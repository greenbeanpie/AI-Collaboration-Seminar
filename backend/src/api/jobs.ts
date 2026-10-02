import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { getJob, tryDispatchJob } from '../services/jobs';
import { reserveAiSlot, settleReservation } from '../services/budget';
import { assertProfileStamp } from '../services/personal-profiles';

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
  app.use('/api/v1/jobs/:jobId/*', requireUser);

  app.openapi(getRoute, async (c) => {
    const job = await getJob(c.env, c.req.valid('param').jobId);
    // 项目任务仅项目成员可见
    if (job.project_id) {
      const member = await c.env.DB.prepare('SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2')
        .bind(job.project_id, c.get('user')!.id)
        .first<{ role: string }>();
      if (!member) throw permissionDenied('不是项目成员');
    }
    const input = JSON.parse(job.input_json) as {operation?:string;profileStamp?:string};
    if (job.project_id && (job.kind === 'assignment_suggest' || input.operation === 'collaboration.assign')) {
      await assertProfileStamp(c.env,job.project_id,input.profileStamp);
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
    if (input.operation === 'source.summary') throw invalidState('请在文件总结状态中单独重试，以核对最新总结版本');
    if (typeof input.operation === 'string' && input.operation.startsWith('collaboration.')) throw invalidState('协作任务请从当前任务重新发起，以重新核对版本与预算');
    if(job.kind==='rehearsal_turn') {
      const rehearsal=await c.env.DB.prepare('SELECT created_by,processing_job_id,status FROM rehearsals WHERE id=?1 AND project_id=?2').bind(input.rehearsalId,job.project_id).first<{created_by:string;processing_job_id:string|null;status:string}>();
      if(!rehearsal || rehearsal.created_by!==c.get('user')!.id)throw permissionDenied('只有本轮发起人可以重试答辩');
      if(rehearsal.status!=='active'||rehearsal.processing_job_id!==job.id)throw invalidState('答辩作业已变化，不能重试旧作业');
    }
    const newJobId = newId();
    const now = nowIso();
    const reservedAiKind = new Set(['assignment_suggest', 'agent_run', 'review_run', 'rehearsal_turn']).has(job.kind);
    if (reservedAiKind && job.project_id) {
      await reserveAiSlot(c.env, { projectId: job.project_id, jobId: newJobId, purpose: job.kind,maxCalls:job.kind==='rehearsal_turn'?24:(job.kind==='agent_run'&&input.requestedBy)||(job.kind==='assignment_suggest'&&input.operation==='collaboration.decompose')?5:2 });
    }
    try {
      const written=await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) SELECT ?1, ?2, ?3, 'queued', ?4, 0, ?5, ?6, ?6 WHERE ?3!='rehearsal_turn' OR EXISTS(SELECT 1 FROM rehearsals WHERE id=json_extract(?4,'$.rehearsalId') AND project_id=?2 AND created_by=?5 AND processing_job_id=?7 AND status='active')",
        ).bind(newJobId, job.project_id, job.kind, JSON.stringify(input), c.get('user')!.id, now, job.id),
        c.env.DB.prepare(
          "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) SELECT ?1, ?2, 'pending', ?3, 0, ?4, ?4 WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?2)",
        ).bind(newId(), newJobId, now, now),
        ...(job.kind==='rehearsal_turn'?[c.env.DB.prepare('UPDATE rehearsals SET processing_job_id=?2,finish_job_id=CASE WHEN finish_job_id=?3 THEN ?2 ELSE finish_job_id END WHERE id=?1 AND processing_job_id=?3 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)').bind(input.rehearsalId,newJobId,job.id),c.env.DB.prepare("UPDATE assessments SET job_id=?2,status='active' WHERE entity_id=?1 AND job_id=?3 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)").bind(input.rehearsalId,newJobId,job.id)]:[]),
      ]);
      if(!written[0]?.meta.changes)throw invalidState('答辩作业已变化，请刷新');
    } catch (error) {
      if (reservedAiKind) await settleReservation(c.env, newJobId, 'released');
      throw error;
    }
    await tryDispatchJob(c.env, newJobId);
    return c.json(apiData(c, { jobId: newJobId }), 202);
  });
}
