import { effectiveStandard, assertEffectiveStandard, effectiveStandardGuardSql } from '../services/effective-standard';
import type { FeedbackSnapshot } from '../services/project-feedback';
import { currentJobClarification } from '../services/ai-clarifications';
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
    feedbackSnapshot: z.object({versionId:z.string().nullable(),version:z.number(),feedback:z.string(),actorId:z.string().nullable(),createdAt:z.string().nullable()}).optional(),
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
    const input = JSON.parse(job.input_json) as {operation?:string;profileStamp?:string;feedbackSnapshot?:FeedbackSnapshot};
    if (job.project_id && (job.kind === 'assignment_suggest' || input.operation === 'collaboration.assign')) {
      await assertProfileStamp(c.env,job.project_id,input.profileStamp);
    }
    const clarification=job.status==='waiting_input'?await currentJobClarification(c.env,job.id,c.get('user')!.id):null;
    return c.json(
      apiData(c, {
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        result: clarification ? {...(job.result_json?JSON.parse(job.result_json):{}),clarification} : job.result_json ? (JSON.parse(job.result_json) as unknown) : null,
        error: job.error_json ? (JSON.parse(job.error_json) as unknown) : null,
        feedbackSnapshot: input.feedbackSnapshot,
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
    if (input.operation === 'standards.generate') throw invalidState('请从项目标准重新生成，以核对当前目标和权限');
    if (input.operation === 'collaboration.evaluate') throw invalidState('每轮提交仅评价一次，请负责人验收或提交新的成果轮次');
    if (typeof input.operation === 'string' && input.operation.startsWith('collaboration.')) throw invalidState('协作任务请从当前任务重新发起，以重新核对版本与预算');
    if(job.kind==='rehearsal_turn') {
      const rehearsal=await c.env.DB.prepare('SELECT created_by,processing_job_id,status FROM rehearsals WHERE id=?1 AND project_id=?2').bind(input.rehearsalId,job.project_id).first<{created_by:string;processing_job_id:string|null;status:string}>();
      if(!rehearsal || rehearsal.created_by!==c.get('user')!.id)throw permissionDenied('只有本轮发起人可以重试答辩');
      if(rehearsal.status!=='active'||rehearsal.processing_job_id!==job.id)throw invalidState('答辩作业已变化，不能重试旧作业');
    }
    let retryStandardId:string|null|undefined;
    if(job.project_id && (job.kind==='review_run'||job.kind==='rehearsal_turn')) {
      let standardId=typeof input.standardsVersionId==='string'?input.standardsVersionId:null;
      if(typeof input.assessmentId==='string'||job.kind==='rehearsal_turn') {
        const row=await c.env.DB.prepare('SELECT standards_version_id FROM assessments WHERE project_id=?1 AND (id=?2 OR entity_id=?3)').bind(job.project_id,input.assessmentId??null,input.rehearsalId??null).first<{standards_version_id:string}>();
        standardId=row?.standards_version_id??standardId;
      }
      if(!standardId && job.kind==='rehearsal_turn') {
        const row=await c.env.DB.prepare('SELECT reference_inputs_json FROM rehearsals WHERE id=?1 AND project_id=?2').bind(input.rehearsalId,job.project_id).first<{reference_inputs_json:string}>();
        standardId=(JSON.parse(row?.reference_inputs_json??'{}') as {standardsVersionId?:string}).standardsVersionId??null;
      }
      if(!standardId)throw invalidState('请使用当前生效标准重新发起操作');
      await assertEffectiveStandard(c.env,job.project_id,standardId);
      retryStandardId=standardId;
    }
    if(job.project_id && job.kind==='assignment_suggest') {
      const current=await effectiveStandard(c.env,job.project_id);
      const captured=typeof input.standardsVersionId==='string'?input.standardsVersionId:null;
      if((current?.standardsVersionId??null)!==captured)throw invalidState('项目标准已更新，请使用当前标准重新生成建议');
      retryStandardId=captured;
    }
    const retryStandardGuard=retryStandardId===undefined?'?8 IS NULL':retryStandardId?effectiveStandardGuardSql('?2','?8'):'(?8 IS NULL AND NOT EXISTS(SELECT 1 FROM standards_versions WHERE project_id=?2))';
    const newJobId = newId();
    const now = nowIso();
    const reservedAiKind = new Set(['assignment_suggest', 'agent_run', 'review_run', 'rehearsal_turn']).has(job.kind);
    if (reservedAiKind && job.project_id) {
      await reserveAiSlot(c.env, { projectId: job.project_id, jobId: newJobId, purpose: job.kind,maxCalls:job.kind==='rehearsal_turn'?24:(job.kind==='agent_run'&&input.requestedBy)||(job.kind==='assignment_suggest'&&input.operation==='collaboration.decompose')?5:2 });
    }
    try {
      const written=await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) SELECT ?1, ?2, ?3, 'queued', ?4, 0, ?5, ?6, ?6 WHERE (?3!='rehearsal_turn' OR EXISTS(SELECT 1 FROM rehearsals WHERE id=json_extract(?4,'$.rehearsalId') AND project_id=?2 AND created_by=?5 AND processing_job_id=?7 AND status='active' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?5))) AND ${retryStandardGuard}`,
        ).bind(newJobId, job.project_id, job.kind, JSON.stringify(input), c.get('user')!.id, now, job.id,retryStandardId??null),
        c.env.DB.prepare(
          "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) SELECT ?1, ?2, 'pending', ?3, 0, ?4, ?4 WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?2)",
        ).bind(newId(), newJobId, now, now),
        ...(job.kind==='rehearsal_turn'?[c.env.DB.prepare('UPDATE rehearsals SET processing_job_id=?2,finish_job_id=CASE WHEN finish_job_id=?3 THEN ?2 ELSE finish_job_id END WHERE id=?1 AND processing_job_id=?3 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)').bind(input.rehearsalId,newJobId,job.id),c.env.DB.prepare("UPDATE assessments SET job_id=?2,status='active' WHERE entity_id=?1 AND job_id=?3 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)").bind(input.rehearsalId,newJobId,job.id)]:[]),
      ]);
      if(!written[0]?.meta.changes)throw invalidState('项目标准或作业已变化，请重新发起');
    } catch (error) {
      if (reservedAiKind) await settleReservation(c.env, newJobId, 'released');
      throw error;
    }
    await tryDispatchJob(c.env, newJobId);
    return c.json(apiData(c, { jobId: newJobId }), 202);
  });
}
