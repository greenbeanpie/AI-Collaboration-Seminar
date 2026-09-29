import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, validationFailed, versionConflict } from '../core/errors';
import { createJobAndDispatch } from '../services/jobs';
import { withIdempotency } from '../services/idempotency';
import { reserveAiSlot } from '../services/budget';
import { recordEvent } from '../services/events';
import { docToMarkdown, isTiptapDoc } from '../services/tiptap';
import { projectParams } from './projects';

const DOC_MAX_BYTES = 200 * 1024;

const sessionParams = projectParams.extend({ sessionId: z.string().uuid() });
const runParams = projectParams.extend({ runId: z.string().uuid() });

// 冻结写请求 #1（PLAN 二.8）：mode、roleTemplate、taskId、instruction、materialVersionIds、sourceVersionIds
const createBody = z.object({
  mode: z.enum(['do', 'guide', 'review_only']),
  roleTemplate: z.string().max(200).optional(),
  taskId: z.string().uuid().nullable().default(null),
  instruction: z.string().max(4000).nullable().default(null),
  materialVersionIds: z.array(z.string().uuid()).max(10).default([]),
  sourceVersionIds: z.array(z.string().uuid()).max(10).default([]),
});

const createResponse = apiEnvelope(
  z.object({ sessionId: z.string().uuid(), runId: z.string().uuid(), jobId: z.string().uuid() }),
  'AgentSessionCreateResponse',
);

const turnBody = z.object({ content: z.string().min(1).max(8000) });
const turnResponse = apiEnvelope(
  z.object({ turnId: z.string().uuid(), sequence: z.number().int(), runId: z.string().uuid(), jobId: z.string().uuid() }),
  'AgentTurnResponse',
);

const sessionSchema = z.object({
  sessionId: z.string().uuid(),
  capability: z.enum(['do', 'guide', 'review_only']),
  status: z.enum(['active', 'closed']),
  taskId: z.string().uuid().nullable(),
  turns: z.array(
    z.object({
      sequence: z.number().int(),
      role: z.enum(['user', 'assistant']),
      kind: z.enum(['instruction', 'answer', 'draft', 'question', 'review_result']),
      runId: z.string().uuid().nullable(),
      payload: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      runId: z.string().uuid(),
      status: z.string(),
      capability: z.string(),
    }),
  ),
});
const sessionResponse = apiEnvelope(sessionSchema, 'AgentSessionResponse');

// 冻结写请求 #2：materialId、expectedRevision、reviewed: true、Tiptap JSON
const adoptBody = z.object({
  materialId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  reviewed: z.boolean(),
  doc: z.record(z.string(), z.unknown()),
  markdown: z.string().max(200_000).optional(),
});
const adoptResponse = apiEnvelope(
  z.object({ materialVersionId: z.string().uuid(), revision: z.number().int() }),
  'AgentAdoptResponse',
);

const agentCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/agent-sessions',
  tags: ['agent'],
  summary: '发起三档 AI 补位（冻结写请求：mode/roleTemplate/taskId/instruction/materialVersionIds/sourceVersionIds）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: createResponse } }, description: '会话已创建，运行中（轮询 jobId）' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '并发/预算超限（QUOTA_EXCEEDED）' },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/agent-sessions/{sessionId}',
  tags: ['agent'],
  summary: 'AI 会话详情（含回合与运行状态）',
  request: { params: sessionParams },
  responses: { 200: { content: { 'application/json': { schema: sessionResponse } }, description: '详情' } },
});

const turnRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/agent-sessions/{sessionId}/turns',
  tags: ['agent'],
  summary: '带做：提交回答并触发下一轮（202 + jobId）',
  request: { params: sessionParams, body: { content: { 'application/json': { schema: turnBody } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: turnResponse } }, description: '已提交' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '会话已关闭或非带做模式' },
  },
});

const adoptRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/agent-runs/{runId}/adopt',
  tags: ['agent'],
  summary: '采纳 AI 草稿为新材料版本（冻结写请求：materialId/expectedRevision/reviewed/doc；reviewed 必须为 true）',
  request: { params: runParams, body: { content: { 'application/json': { schema: adoptBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: adoptResponse } }, description: '已采纳为新版本' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '未确认人工复核' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '版本冲突/运行状态不允许' },
  },
});

interface SessionRow {
  id: string;
  project_id: string;
  capability: 'do' | 'guide' | 'review_only';
  status: 'active' | 'closed';
  task_id: string | null;
}

interface RunRow {
  id: string;
  status: string;
  capability: string;
  output_json: string | null;
}

/** 创建运行记录 + 预算预占 + 派发任务 */
async function createRunAndJob(
  env: AppEnv['Bindings'],
  params: {
    projectId: string;
    userId: string;
    sessionId: string | null;
    capability: 'do' | 'guide' | 'review_only';
    taskId: string | null;
    instruction: string | null;
    roleTemplate: string | null;
    materialVersionIds: string[];
    sourceVersionIds: string[];
    turnSequence: number | null;
  },
): Promise<{ runId: string; jobId: string }> {
  const runId = newId();
  await env.DB.prepare(
    "INSERT INTO agent_runs (id, session_id, project_id, capability, mode, status, inputs_json, prompt_version, created_at) VALUES (?1, ?2, ?3, ?4, ?4, 'running', ?5, 'agent-v1', ?6)",
  )
    .bind(
      runId,
      params.sessionId,
      params.projectId,
      params.capability,
      JSON.stringify({
        taskId: params.taskId,
        instruction: params.instruction,
        roleTemplate: params.roleTemplate,
        materialVersionIds: params.materialVersionIds,
        sourceVersionIds: params.sourceVersionIds,
        turnSequence: params.turnSequence,
      }),
      nowIso(),
    )
    .run();

  const jobId = await createJobAndDispatch(env, {
    projectId: params.projectId,
    kind: 'agent_run',
    input: {
      runId,
      projectId: params.projectId,
      capability: params.capability,
      taskId: params.taskId,
      instruction: params.instruction,
      roleTemplate: params.roleTemplate,
      materialVersionIds: params.materialVersionIds,
      sourceVersionIds: params.sourceVersionIds,
      turnSequence: params.turnSequence,
    },
    createdBy: params.userId,
  });
  // 预算预占在任务创建后登记（并发检查 + 预占记录）
  await reserveAiSlot(env, { projectId: params.projectId, jobId, purpose: 'agent_run' });
  return { runId, jobId };
}

async function loadSession(env: AppEnv['Bindings'], sessionId: string, projectId: string): Promise<SessionRow> {
  const row = await env.DB.prepare('SELECT id, project_id, capability, status, task_id FROM agent_sessions WHERE id = ?1 AND project_id = ?2')
    .bind(sessionId, projectId)
    .first<SessionRow>();
  if (!row) throw notFound('AI 会话不存在');
  return row;
}

async function sessionDetail(env: AppEnv['Bindings'], session: SessionRow) {
  const turns = await env.DB.prepare(
    'SELECT sequence, role, kind, run_id, payload_json, created_at FROM agent_turns WHERE session_id = ?1 ORDER BY sequence',
  )
    .bind(session.id)
    .all<{ sequence: number; role: string; kind: string; run_id: string | null; payload_json: string; created_at: string }>();
  const runs = await env.DB.prepare(
    'SELECT id, status, capability FROM agent_runs WHERE session_id = ?1 ORDER BY created_at',
  )
    .bind(session.id)
    .all<{ id: string; status: string; capability: string }>();
  return {
    sessionId: session.id,
    capability: session.capability,
    status: session.status,
    taskId: session.task_id,
    turns: turns.results.map((t) => ({
      sequence: t.sequence,
      role: t.role as 'user' | 'assistant',
      kind: t.kind as 'instruction' | 'answer' | 'draft' | 'question' | 'review_result',
      runId: t.run_id,
      payload: JSON.parse(t.payload_json) as Record<string, unknown>,
      createdAt: t.created_at,
    })),
    runs: runs.results.map((r) => ({ runId: r.id, status: r.status, capability: r.capability })),
  };
}

export function registerAgentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/agent-sessions/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/agent-runs/*', requireUser, requireProjectMember());

  app.openapi(agentCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const idem = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'),
      userId: user.id,
      operation: 'agent-session.create',
      // zod 校验已消费原始流，用解析后 body 的稳定序列化做请求哈希
      rawBody: JSON.stringify(body),
    }, async () => {
      // 输入归属校验（任务/材料/来源必须属于本项目）
      if (body.taskId) {
        const task = await c.env.DB.prepare('SELECT id, title FROM tasks WHERE id = ?1 AND project_id = ?2')
          .bind(body.taskId, member.projectId)
          .first<{ id: string; title: string }>();
        if (!task) throw notFound('任务不存在或不属于本项目');
      }
      for (const versionId of body.materialVersionIds) {
        const row = await c.env.DB.prepare(
          'SELECT v.id FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ?1 AND m.project_id = ?2',
        )
          .bind(versionId, member.projectId)
          .first();
        if (!row) throw notFound(`材料版本 ${versionId} 不存在或不属于本项目`);
      }
      for (const versionId of body.sourceVersionIds) {
        const row = await c.env.DB.prepare('SELECT id FROM source_versions WHERE id = ?1 AND project_id = ?2')
          .bind(versionId, member.projectId)
          .first();
        if (!row) throw notFound(`来源版本 ${versionId} 不存在或不属于本项目`);
      }

      const sessionId = newId();
      const now = nowIso();
      await c.env.DB.prepare(
        "INSERT INTO agent_sessions (id, project_id, capability, title, task_id, status, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)",
      )
        .bind(sessionId, member.projectId, body.mode, (body.instruction ?? body.roleTemplate ?? body.mode).slice(0, 100), body.taskId, user.id, now)
        .run();

      const { runId, jobId } = await createRunAndJob(c.env, {
        projectId: member.projectId,
        userId: user.id,
        sessionId,
        capability: body.mode,
        taskId: body.taskId,
        instruction: body.instruction,
        roleTemplate: body.roleTemplate ?? null,
        materialVersionIds: body.materialVersionIds,
        sourceVersionIds: body.sourceVersionIds,
        turnSequence: 1,
      });
      return { status: 202 as const, body: { sessionId, runId, jobId } };
    });
    return c.json(apiData(c, idem.body), idem.status);
  });

  app.openapi(getRoute, async (c) => {
    const session = await loadSession(c.env, c.req.valid('param').sessionId, c.get('member')!.projectId);
    return c.json(apiData(c, await sessionDetail(c.env, session)), 200);
  });

  app.openapi(turnRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const session = await loadSession(c.env, c.req.valid('param').sessionId, member.projectId);
    if (session.status !== 'active') throw invalidState('会话已关闭');
    if (session.capability !== 'guide') throw invalidState('仅带做模式支持逐轮交互');

    const maxTurn = await c.env.DB.prepare('SELECT MAX(sequence) AS m FROM agent_turns WHERE session_id = ?1')
      .bind(session.id)
      .first<{ m: number | null }>();
    const sequence = (maxTurn?.m ?? 0) + 1;
    const turnId = newId();
    await c.env.DB.prepare(
      "INSERT INTO agent_turns (id, session_id, project_id, sequence, role, kind, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, 'user', 'answer', ?5, ?6)",
    )
      .bind(turnId, session.id, member.projectId, sequence, JSON.stringify({ answer: body.content }), nowIso())
      .run();

    const lastRun = await c.env.DB.prepare(
      'SELECT inputs_json FROM agent_runs WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 1',
    )
      .bind(session.id)
      .first<{ inputs_json: string }>();
    const lastInputs = lastRun ? (JSON.parse(lastRun.inputs_json) as { taskId: string | null; instruction: string | null; roleTemplate: string | null; materialVersionIds: string[]; sourceVersionIds: string[] }) : { taskId: null, instruction: null, roleTemplate: null, materialVersionIds: [], sourceVersionIds: [] };

    const { runId, jobId } = await createRunAndJob(c.env, {
      projectId: member.projectId,
      userId: c.get('user')!.id,
      sessionId: session.id,
      capability: 'guide',
      taskId: lastInputs.taskId,
      instruction: lastInputs.instruction,
      roleTemplate: lastInputs.roleTemplate,
      materialVersionIds: lastInputs.materialVersionIds,
      sourceVersionIds: lastInputs.sourceVersionIds,
      turnSequence: sequence + 1,
    });
    return c.json(apiData(c, { turnId, sequence, runId, jobId }), 202);
  });

  app.openapi(adoptRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    if (body.reviewed !== true) {
      throw validationFailed('采纳必须明确确认已人工复核（reviewed: true）');
    }
    if (!isTiptapDoc(body.doc)) throw validationFailed('doc 必须是 Tiptap JSON（{type:"doc", content:[...]}）');
    if (JSON.stringify(body.doc).length > DOC_MAX_BYTES) throw validationFailed('doc 超过大小限制');
    const markdown = body.markdown ?? docToMarkdown(body.doc);

    const idem = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'),
      userId: user.id,
      operation: 'agent-run.adopt',
      rawBody: JSON.stringify(body),
    }, async () => {
      const run = await c.env.DB.prepare('SELECT id, project_id, status, output_json FROM agent_runs WHERE id = ?1 AND project_id = ?2')
        .bind(c.req.valid('param').runId, member.projectId)
        .first<RunRow>();
      if (!run) throw notFound('AI 运行不存在');
      if (run.status !== 'succeeded') throw invalidState('仅成功的运行可采纳');
      if (run.output_json === null || (JSON.parse(run.output_json) as Record<string, unknown>)['markdown'] === undefined) {
        throw invalidState('该运行没有可采纳的草稿');
      }

      const material = await c.env.DB.prepare('SELECT id, revision FROM materials WHERE id = ?1 AND project_id = ?2')
        .bind(body.materialId, member.projectId)
        .first<{ id: string; revision: number }>();
      if (!material) throw notFound('材料不存在');
      if (material.revision !== body.expectedRevision) throw versionConflict(material.revision);

      const latest = await c.env.DB.prepare('SELECT MAX(revision) AS r FROM material_versions WHERE material_id = ?1')
        .bind(material.id)
        .first<{ r: number | null }>();
      const newRevision = (latest?.r ?? 0) + 1;
      const versionId = newId();
      const now = nowIso();

      // 版本 + 指针 + 运行标记 + 账本事件（PLAN 二.7：原子提交语义）
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO material_versions (id, material_id, project_id, revision, doc_json, markdown, origin, ai_run_id, author_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ai_adoption', ?7, ?8, ?9)`,
        ).bind(versionId, material.id, member.projectId, newRevision, JSON.stringify(body.doc), markdown, run.id, user.id, now),
        c.env.DB.prepare(
          'UPDATE materials SET current_version_id = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1 AND revision = ?4',
        ).bind(material.id, versionId, now, body.expectedRevision),
        c.env.DB.prepare(
          "UPDATE agent_runs SET status = 'adopted', adopted_at = ?2, adoption_material_version_id = ?3 WHERE id = ?1 AND status = 'succeeded'",
        ).bind(run.id, now, versionId),
      ]);
      if ((results[1]?.meta?.changes ?? 0) === 0) {
        await c.env.DB.prepare('DELETE FROM material_versions WHERE id = ?1').bind(versionId).run();
        await c.env.DB.prepare("UPDATE agent_runs SET status = 'succeeded', adopted_at = NULL, adoption_material_version_id = NULL WHERE id = ?1").bind(run.id).run();
        throw versionConflict(material.revision);
      }
      await recordEvent(c.env, {
        projectId: member.projectId,
        actorType: 'user',
        actorId: user.id,
        type: 'material.adopted',
        entityType: 'material_version',
        entityId: versionId,
        dedupKey: run.id,
        payload: { runId: run.id, revision: newRevision, aiRunId: run.id },
      });
      return { status: 201 as const, body: { materialVersionId: versionId, revision: newRevision } };
    });
    return c.json(apiData(c, idem.body), idem.status);
  });
}
