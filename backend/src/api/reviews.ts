import { effectiveStandard, effectiveStandardGuardSql } from '../services/effective-standard';
import { projectPermissionSql, requireProjectPermission } from '../services/project-permissions';
import { snapshotRequirementSources } from '../services/source-inputs';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { notFound,invalidState , permissionDenied } from '../core/errors';
import { createJobAndDispatch } from '../services/jobs';
import { withIdempotency } from '../services/idempotency';
import { withReservedAiJob } from '../services/budget';
import { projectParams } from './projects';

const reviewParams = projectParams.extend({ reviewId: z.string().uuid() });

// 冻结写请求 #3：rubricVersionId、requirementSetId、materialVersionIds
const createBody = z.object({
  rubricVersionId: z.string().uuid().optional(),
  requirementSetId: z.string().uuid().optional(),
  materialVersionIds: z.array(z.string().uuid()).min(1).max(10),
});

const reportSchema = z.object({
  scores: z.array(
    z.object({
      key: z.string(),
      score: z.number().nullable(),
      comment: z.string(),
      suggestions: z.array(z.string()),
    }),
  ),
  overall: z.object({ score: z.number().nullable(), summary: z.string() }),
  status:z.enum(['scored','unscorable']).optional(),
  limitations:z.array(z.string()).optional(),
  references:z.array(z.unknown()).optional(),decisionReferences:z.array(z.unknown()).optional(),
  rubricVersion: z.number().int().optional(),
  materialVersionIds: z.array(z.string().uuid()).optional(),
});

const reviewSchema = z.object({
  reviewId: z.string().uuid(),
  requirementSetId: z.string().uuid(),
  rubricVersionId: z.string().uuid(),
  materialVersionIds: z.array(z.string().uuid()),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  report: z.unknown().nullable(),
  createdAt: z.string(),
});
const reviewResponse = apiEnvelope(reviewSchema, 'ReviewResponse');
const reviewListResponse = apiEnvelope(z.object({ items: z.array(reviewSchema) }), 'ReviewListResponse');

const reviewCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/reviews',
  tags: ['reviews'],
  summary: '发起预审（冻结写请求：rubricVersionId/requirementSetId/materialVersionIds；202 + jobId）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: apiEnvelope(z.object({ reviewId: z.string().uuid(), jobId: z.string().uuid() }), 'ReviewCreateResponse') } }, description: '已排队' },
    404: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '输入不属于本项目' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '评分标准尚未确认' },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/reviews/{reviewId}',
  tags: ['reviews'],
  summary: '预审详情（报告绑定输入版本；材料更新后前端应提示报告针对旧版本）',
  request: { params: reviewParams },
  responses: { 200: { content: { 'application/json': { schema: reviewResponse } }, description: '详情' } },
});

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/reviews',
  tags: ['reviews'],
  summary: '预审记录列表',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: reviewListResponse } }, description: '列表' } },
});

interface ReviewRow {
  id: string;
  project_id: string;
  requirement_set_id: string;
  rubric_version_id: string;
  material_version_ids_json: string;
  status: string;
  report_json: string | null;
  created_at: string;
}

function toReview(r: ReviewRow) {
  return {
    reviewId: r.id,
    requirementSetId: r.requirement_set_id,
    rubricVersionId: r.rubric_version_id,
    materialVersionIds: JSON.parse(r.material_version_ids_json) as string[],
    status: r.status as 'pending' | 'running' | 'succeeded' | 'failed',
    report: r.report_json ? (JSON.parse(r.report_json) as unknown) : null,
    createdAt: r.created_at,
  };
}

export function registerReviewRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/reviews/*', requireUser, requireProjectMember());

  app.openapi(reviewCreateRoute, async (c) => {
    await requireProjectPermission(c.env,c.get('member')!.projectId,c.get('user')!.id,'scoreInitiate');
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const idem = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'),
      userId: user.id,
      operation: 'review.create',
      rawBody: JSON.stringify(body),
      required: true,
    }, async () => {
      const standard = await effectiveStandard(c.env, member.projectId);
      if (!standard) throw invalidState('请先保存项目标准');
      if ((body.rubricVersionId && body.rubricVersionId !== standard.rubricVersionId) || (body.requirementSetId && !standard.requirementSetIds.includes(body.requirementSetId))) throw invalidState('项目标准已更新，请使用当前生效标准重新发起');
      const requirementSetId = standard.requirementSetIds[0];
      if (!requirementSetId) throw invalidState('当前项目标准没有要求');
      const sourceSnapshots = (await Promise.all(standard.requirementSetIds.map(id => snapshotRequirementSources(c.env, member.projectId, id)))).flat();
      for (const versionId of body.materialVersionIds) {
        const row = await c.env.DB.prepare(
          'SELECT v.id FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ?1 AND m.project_id = ?2',
        )
          .bind(versionId, member.projectId)
          .first();
        if (!row) throw notFound(`材料版本 ${versionId} 不存在或不属于本项目`);
      }

      return withReservedAiJob(c.env, { projectId: member.projectId, purpose: 'review_run',maxCalls:24 }, async (jobId, configVersionId) => {
        const reviewId = newId();
        const inserted=await c.env.DB.prepare(
          `INSERT INTO reviews (id, project_id, requirement_set_id, rubric_version_id, material_version_ids_json, status, created_by, created_at) SELECT ?1,?2,?3,?4,?5,'pending',?6,?7 WHERE ${projectPermissionSql('?2','?6','scoreInitiate')} AND ${effectiveStandardGuardSql('?2','?8')}`,
        )
          .bind(reviewId, member.projectId, requirementSetId, standard.rubricVersionId, JSON.stringify(body.materialVersionIds), user.id, nowIso(), standard.standardsVersionId)
          .run();
        if(!inserted.meta.changes)throw permissionDenied('评分发起权限已变化');

        try {
          await createJobAndDispatch(c.env, {
            jobId,
            projectId: member.projectId,
            kind: 'review_run',
            input: { reviewId, projectId: member.projectId, configVersionId, sourceSnapshots, standardsVersionId: standard.standardsVersionId },
            createdBy: user.id,
          });
        } catch (error) {
          if (!await c.env.DB.prepare('SELECT id FROM jobs WHERE id = ?1').bind(jobId).first()) await c.env.DB.prepare('DELETE FROM reviews WHERE id = ?1').bind(reviewId).run();
          throw error;
        }
        return { status: 202 as const, body: { reviewId, jobId } };
      });
    });
    return c.json(apiData(c, idem.body), idem.status);
  });

  app.openapi(getRoute, async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM reviews WHERE id = ?1 AND project_id = ?2')
      .bind(c.req.valid('param').reviewId, c.get('member')!.projectId)
      .first<ReviewRow>();
    if (!row) throw notFound('预审记录不存在');
    return c.json(apiData(c, toReview(row)), 200);
  });

  app.openapi(listRoute, async (c) => {
    const rows = await c.env.DB.prepare('SELECT * FROM reviews WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 100')
      .bind(c.get('member')!.projectId)
      .all<ReviewRow>();
    return c.json(apiData(c, { items: rows.results.map(toReview) }), 200);
  });
}
