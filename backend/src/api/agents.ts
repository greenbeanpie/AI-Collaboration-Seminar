import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, validationFailed, versionConflict } from '../core/errors';
import { nextCursor, parsePaging } from '../core/pagination';
import { createJobAndDispatch } from '../services/jobs';
import { withIdempotency } from '../services/idempotency';
import { withReservedAiJob } from '../services/budget';
import { docToMarkdown, isTiptapDoc } from '../services/tiptap';
import { projectParams } from './projects';

const DOC_MAX_BYTES = 200 * 1024;

const sessionParams = projectParams.extend({ sessionId: z.string().uuid() });
const runParams = projectParams.extend({ runId: z.string().uuid() });

// 冻结写请求 #1（PLAN 二.8）：mode、roleTemplate、taskId、instruction、materialVersionIds、sourceVersionIds
const createBody = z.object({
  allowSearch: z.boolean().default(false),
  searchQuery:z.string().trim().min(1).max(500).optional(),
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
      jobId: z.string().uuid().nullable(),
      status: z.string(),
      capability: z.string(),
    }),
  ),
});
const sessionResponse = apiEnvelope(sessionSchema, 'AgentSessionResponse');
const sessionListResponse = apiEnvelope(
  z.object({
    items: z.array(z.object({
      sessionId: z.string().uuid(),
      title: z.string(),
      capability: z.enum(['do', 'guide', 'review_only']),
      status: z.enum(['active', 'closed']),
      taskId: z.string().uuid().nullable(),
      latestRunId: z.string().uuid().nullable(),
      latestRunStatus: z.string().nullable(),
      latestJobId: z.string().uuid().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })),
    nextCursor: z.string().nullable(),
  }),
  'AgentSessionListResponse',
);

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

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/agent-sessions',
  tags: ['agent'],
  summary: '项目 AI 会话列表（游标分页，可按模式和状态筛选；包含最新运行和任务 ID）',
  request: {
    params: projectParams,
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      status: z.enum(['active', 'closed', 'all']).optional(),
      capability: z.enum(['do', 'guide', 'review_only']).optional(),
    }),
  },
  responses: { 200: { content: { 'application/json': { schema: sessionListResponse } }, description: '列表' } },
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
    allowSearch?: boolean;
    searchQuery?: string;
  },
): Promise<{ runId: string; jobId: string }> {
  const runId = newId();
  return withReservedAiJob(env, { projectId: params.projectId, purpose: 'agent_run',maxCalls:5 }, async (jobId, configVersionId) => {
    await env.DB.prepare(
      "INSERT INTO agent_runs (id, session_id, project_id, capability, mode, status, inputs_json, prompt_version, created_at) VALUES (?1, ?2, ?3, ?4, ?4, 'running', ?5, 'agent-v1', ?6)",
    )
      .bind(
        runId,
        params.sessionId,
        params.projectId,
        params.capability,
        JSON.stringify({
          allowSearch:params.allowSearch??false,
          searchQuery:params.searchQuery,
          requestedBy:params.userId,
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

    try {
      await createJobAndDispatch(env, {
        jobId,
        projectId: params.projectId,
        kind: 'agent_run',
        input: {
          configVersionId,
          runId,
          projectId: params.projectId,
          capability: params.capability,
          allowSearch:params.allowSearch??false,
          searchQuery:params.searchQuery,
          requestedBy:params.userId,
          taskId: params.taskId,
          instruction: params.instruction,
          roleTemplate: params.roleTemplate,
          materialVersionIds: params.materialVersionIds,
          sourceVersionIds: params.sourceVersionIds,
          turnSequence: params.turnSequence,
        },
        createdBy: params.userId,
      });
    } catch (error) {
      const job = await env.DB.prepare('SELECT id FROM jobs WHERE id = ?1').bind(jobId).first();
      if (!job) await env.DB.prepare('DELETE FROM agent_runs WHERE id = ?1').bind(runId).run();
      throw error;
    }
    return { runId, jobId };
  });
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
    'SELECT id, job_id, status, capability FROM agent_runs WHERE session_id = ?1 ORDER BY created_at, id',
  )
    .bind(session.id)
    .all<{ id: string; job_id: string | null; status: string; capability: string }>();
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
    runs: runs.results.map((r) => ({ runId: r.id, jobId: r.job_id, status: r.status, capability: r.capability })),
  };
}

export function registerAgentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/agent-sessions', requireUser, requireProjectMember());
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
      required: true,
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
        allowSearch:body.allowSearch,
        searchQuery:body.searchQuery,
      });
      await c.env.DB.prepare('UPDATE agent_runs SET job_id = ?2 WHERE id = ?1').bind(runId, jobId).run();
      return { status: 202 as const, body: { sessionId, runId, jobId } };
    });
    return c.json(apiData(c, idem.body), idem.status);
  });

  app.openapi(listRoute, async (c) => {
    const member = c.get('member')!;
    const query = c.req.valid('query');
    const paging = parsePaging(query);
    const conditions = ['s.project_id = ?1'];
    const binds: unknown[] = [member.projectId];
    if (query.status && query.status !== 'all') {
      binds.push(query.status);
      conditions.push(`s.status = ?${binds.length}`);
    }
    if (query.capability) {
      binds.push(query.capability);
      conditions.push(`s.capability = ?${binds.length}`);
    }
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      conditions.push(`(s.created_at < ?${binds.length - 2} OR (s.created_at = ?${binds.length - 1} AND s.id < ?${binds.length}))`);
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.title, s.capability, s.status, s.task_id, s.created_at, s.updated_at,
              latest.id AS latest_run_id, latest.status AS latest_run_status, latest.job_id AS latest_job_id
         FROM agent_sessions s
         LEFT JOIN agent_runs latest ON latest.id = (
           SELECT r.id FROM agent_runs r WHERE r.session_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1
         )
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<{
        id: string; title: string; capability: 'do' | 'guide' | 'review_only'; status: 'active' | 'closed'; task_id: string | null;
        created_at: string; updated_at: string; latest_run_id: string | null; latest_run_status: string | null; latest_job_id: string | null;
      }>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(apiData(c, {
      items: pageRows.map((row) => ({
        sessionId: row.id,
        title: row.title,
        capability: row.capability,
        status: row.status,
        taskId: row.task_id,
        latestRunId: row.latest_run_id,
        latestRunStatus: row.latest_run_status,
        latestJobId: row.latest_job_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
    }), 200);
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
    const answerCreatedAt = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO agent_turns (id, session_id, project_id, sequence, role, kind, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, 'user', 'answer', ?5, ?6)",
      ).bind(turnId, session.id, member.projectId, sequence, JSON.stringify({ answer: body.content }), answerCreatedAt),
      c.env.DB.prepare('UPDATE agent_sessions SET updated_at = ?2 WHERE id = ?1').bind(session.id, answerCreatedAt),
    ]);

    const lastRun = await c.env.DB.prepare(
      'SELECT inputs_json FROM agent_runs WHERE session_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1',
    )
      .bind(session.id)
      .first<{ inputs_json: string }>();
    const lastInputs = lastRun ? (JSON.parse(lastRun.inputs_json) as { allowSearch?: boolean; searchQuery?:string; taskId: string | null; instruction: string | null; roleTemplate: string | null; materialVersionIds: string[]; sourceVersionIds: string[] }) : { taskId: null, instruction: null, roleTemplate: null, materialVersionIds: [], sourceVersionIds: [] };

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
      allowSearch:lastInputs.allowSearch,
      searchQuery:lastInputs.searchQuery,
    });
    await c.env.DB.prepare('UPDATE agent_runs SET job_id = ?2 WHERE id = ?1').bind(runId, jobId).run();
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
      required: true,
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

      // 所有写入依赖同一条件插入；batch 串行且原子，竞争失败只写零行。
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO material_versions (id, material_id, project_id, revision, doc_json, markdown, origin, ai_run_id, author_id, created_at, attachments_json)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'ai_adoption', ?7, ?8, ?9,
                  COALESCE((SELECT attachments_json FROM material_versions WHERE id = m.current_version_id), '[]')
             FROM materials m WHERE m.id = ?2 AND m.revision = ?10
              AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ?7 AND status = 'succeeded')`,
        ).bind(versionId, material.id, member.projectId, newRevision, JSON.stringify(body.doc), markdown, run.id, user.id, now, body.expectedRevision),
        c.env.DB.prepare(
          "UPDATE agent_runs SET status = 'adopted', adopted_at = ?2, adoption_material_version_id = ?3 WHERE id = ?1 AND status = 'succeeded' AND EXISTS (SELECT 1 FROM material_versions WHERE id = ?3)",
        ).bind(run.id, now, versionId),
        c.env.DB.prepare(
          `UPDATE materials SET current_version_id = ?2, revision = revision + 1, updated_at = ?3
            WHERE id = ?1 AND revision = ?4
              AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ?5 AND adoption_material_version_id = ?2 AND status = 'adopted')`,
        ).bind(material.id, versionId, now, body.expectedRevision, run.id),
        c.env.DB.prepare(
          `INSERT INTO events (id, project_id, actor_type, actor_id, type, entity_type, entity_id, dedup_key, payload_json, occurred_at)
           SELECT ?1, ?2, 'user', ?3, 'material.adopted', 'material_version', ?4, ?5, ?6, ?7
            WHERE EXISTS (SELECT 1 FROM materials WHERE id = ?8 AND current_version_id = ?4)
              AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ?5 AND adoption_material_version_id = ?4)
           ON CONFLICT (project_id, type, entity_type, entity_id, dedup_key) DO NOTHING`,
        ).bind(newId(), member.projectId, user.id, versionId, run.id, JSON.stringify({ runId: run.id, revision: newRevision, aiRunId: run.id }), now, material.id),
      ]);
      if ((results[0]?.meta?.changes ?? 0) === 0) {
        const current = await c.env.DB.prepare('SELECT revision FROM materials WHERE id = ?1').bind(material.id).first<{ revision: number }>();
        if (current?.revision !== body.expectedRevision) throw versionConflict(current?.revision ?? material.revision);
        throw invalidState('该 AI 运行已被其他请求采纳');
      }
      return { status: 201 as const, body: { materialVersionId: versionId, revision: newRevision } };
    });
    return c.json(apiData(c, idem.body), idem.status);
  });
}
