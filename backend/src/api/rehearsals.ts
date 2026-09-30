import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound } from '../core/errors';
import { createJobAndDispatch } from '../services/jobs';
import { reserveAiSlot } from '../services/budget';
import { projectParams } from './projects';

const rehearsalParams = projectParams.extend({ rehearsalId: z.string().uuid() });

const createBody = z.object({
  scope: z.enum(['all', 'member']),
  memberId: z.string().uuid().nullish(),
  materialVersionIds: z.array(z.string().uuid()).max(10).default([]),
});

const turnSchema = z.object({
  sequence: z.number().int(),
  kind: z.enum(['question', 'answer', 'followup', 'summary']),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
});

const rehearsalSchema = z.object({
  rehearsalId: z.string().uuid(),
  scope: z.enum(['all', 'member']),
  memberId: z.string().uuid().nullable(),
  status: z.enum(['active', 'finished']),
  turns: z.array(turnSchema),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
const rehearsalResponse = apiEnvelope(rehearsalSchema, 'RehearsalResponse');

const rehearsalCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/rehearsals',
  tags: ['rehearsals'],
  summary: '发起答辩演练（202 + jobId，第一问生成中）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: apiEnvelope(z.object({ rehearsalId: z.string().uuid(), jobId: z.string().uuid() }), 'RehearsalCreateResponse') } }, description: '已排队' },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/rehearsals/{rehearsalId}',
  tags: ['rehearsals'],
  summary: '演练详情（含全部问答轮次）',
  request: { params: rehearsalParams },
  responses: { 200: { content: { 'application/json': { schema: rehearsalResponse } }, description: '详情' } },
});

const answerRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/rehearsals/{rehearsalId}/answers',
  tags: ['rehearsals'],
  summary: '逐题回答（202 + jobId，追问或点评生成中）',
  request: { params: rehearsalParams, body: { content: { 'application/json': { schema: z.object({ content: z.string().min(1).max(8000) }) } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: apiEnvelope(z.object({ turnId: z.string().uuid(), jobId: z.string().uuid() }), 'RehearsalAnswerResponse') } }, description: '已提交' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '演练已结束' },
  },
});

const finishRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/rehearsals/{rehearsalId}/finish',
  tags: ['rehearsals'],
  summary: '结束演练并生成总结（202 + jobId）',
  request: { params: rehearsalParams },
  responses: {
    202: { content: { 'application/json': { schema: apiEnvelope(z.object({ jobId: z.string().uuid() }), 'RehearsalFinishResponse') } }, description: '总结生成中' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '演练已结束' },
  },
});

interface RehearsalRow {
  id: string;
  project_id: string;
  scope: 'all' | 'member';
  member_id: string | null;
  material_version_ids_json: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

interface TurnRow {
  sequence: number;
  kind: string;
  content_json: string;
  created_at: string;
}

function toRehearsal(r: RehearsalRow, turns: TurnRow[]) {
  return {
    rehearsalId: r.id,
    scope: r.scope,
    memberId: r.member_id,
    status: r.status as 'active' | 'finished',
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    turns: turns.map((t) => ({
      sequence: t.sequence,
      // 表中无 role 列：answer 为答辩人发言，其余为评委侧
      role: (t.kind === 'answer' ? 'user' : 'assistant') as 'user' | 'assistant',
      kind: t.kind as 'question' | 'answer' | 'followup' | 'summary',
      content: (JSON.parse(t.content_json) as { content?: string }).content ?? '',
      createdAt: t.created_at,
    })),
  };
}

async function loadRehearsal(env: AppEnv['Bindings'], rehearsalId: string, projectId: string): Promise<RehearsalRow> {
  const row = await env.DB.prepare('SELECT * FROM rehearsals WHERE id = ?1 AND project_id = ?2')
    .bind(rehearsalId, projectId)
    .first<RehearsalRow>();
  if (!row) throw notFound('答辩演练不存在');
  return row;
}

async function loadTurns(env: AppEnv['Bindings'], rehearsalId: string): Promise<TurnRow[]> {
  const rows = await env.DB.prepare(
    'SELECT sequence, kind, content_json, created_at FROM rehearsal_turns WHERE rehearsal_id = ?1 ORDER BY sequence',
  )
    .bind(rehearsalId)
    .all<TurnRow>();
  return rows.results;
}

export function registerRehearsalRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/rehearsals/*', requireUser, requireProjectMember());

  app.openapi(rehearsalCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    for (const versionId of body.materialVersionIds) {
      const row = await c.env.DB.prepare(
        'SELECT v.id FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ?1 AND m.project_id = ?2',
      )
        .bind(versionId, member.projectId)
        .first();
      if (!row) throw notFound(`材料版本 ${versionId} 不存在或不属于本项目`);
    }
    if (body.scope === 'member') {
      if (!body.memberId) {
        const members = await c.env.DB.prepare('SELECT user_id FROM project_members WHERE project_id = ?1')
          .bind(member.projectId)
          .all<{ user_id: string }>();
        throw notFound(`按成员演练必须提供项目内成员 memberId（可选：${members.results.map((m) => m.user_id.slice(0, 8)).join(', ')})`);
      }
      const memberRow = await c.env.DB.prepare('SELECT id FROM project_members WHERE project_id = ?1 AND user_id = ?2')
        .bind(member.projectId, body.memberId)
        .first();
      if (!memberRow) throw notFound('成员不存在或不属于本项目');
    }

    const rehearsalId = newId();
    await c.env.DB.prepare(
      "INSERT INTO rehearsals (id, project_id, scope, member_id, material_version_ids_json, status, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)",
    )
      .bind(rehearsalId, member.projectId, body.scope, body.memberId ?? null, JSON.stringify(body.materialVersionIds), user.id, nowIso())
      .run();

    const jobId = await createJobAndDispatch(c.env, {
      projectId: member.projectId,
      kind: 'rehearsal_turn',
      input: { rehearsalId, projectId: member.projectId, phase: 'question' },
      createdBy: user.id,
    });
    await reserveAiSlot(c.env, { projectId: member.projectId, jobId, purpose: 'rehearsal_turn' });
    return c.json(apiData(c, { rehearsalId, jobId }), 202);
  });

  app.openapi(getRoute, async (c) => {
    const rehearsal = await loadRehearsal(c.env, c.req.valid('param').rehearsalId, c.get('member')!.projectId);
    return c.json(apiData(c, toRehearsal(rehearsal, await loadTurns(c.env, rehearsal.id))), 200);
  });

  app.openapi(answerRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const rehearsal = await loadRehearsal(c.env, c.req.valid('param').rehearsalId, member.projectId);
    if (rehearsal.status !== 'active') throw invalidState('演练已结束');
    if ((await loadTurns(c.env, rehearsal.id)).length === 0) throw invalidState('第一问尚未生成，请稍后');

    const turnId = newId();
    await c.env.DB.prepare(
      "INSERT INTO rehearsal_turns (id, rehearsal_id, project_id, sequence, kind, content_json, created_at) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM rehearsal_turns WHERE rehearsal_id = ?4), 'answer', ?5, ?6)",
    )
      .bind(turnId, rehearsal.id, member.projectId, rehearsal.id, JSON.stringify({ content: body.content }), nowIso())
      .run();

    const jobId = await createJobAndDispatch(c.env, {
      projectId: member.projectId,
      kind: 'rehearsal_turn',
      input: { rehearsalId: rehearsal.id, projectId: member.projectId, phase: 'followup' },
      createdBy: user.id,
    });
    await reserveAiSlot(c.env, { projectId: member.projectId, jobId, purpose: 'rehearsal_turn' });
    return c.json(apiData(c, { turnId, jobId }), 202);
  });

  app.openapi(finishRoute, async (c) => {
    const member = c.get('member')!;
    const user = c.get('user')!;
    const rehearsal = await loadRehearsal(c.env, c.req.valid('param').rehearsalId, member.projectId);
    if (rehearsal.status !== 'active') throw invalidState('演练已结束');

    const jobId = await createJobAndDispatch(c.env, {
      projectId: member.projectId,
      kind: 'rehearsal_turn',
      input: { rehearsalId: rehearsal.id, projectId: member.projectId, phase: 'summary' },
      createdBy: user.id,
    });
    await reserveAiSlot(c.env, { projectId: member.projectId, jobId, purpose: 'rehearsal_turn' });
    return c.json(apiData(c, { jobId }), 202);
  });
}
