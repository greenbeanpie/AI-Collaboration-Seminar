import { configureGoFixture } from './helpers/provider-config';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runAgentJob } from '../src/services/agent';
import { runParseJob } from '../src/services/parse';
import { releaseStaleReservations, reserveAiSlot, settleReservation } from '../src/services/budget';
import { markdownToDoc } from '../src/services/tiptap';
import { quotaExceeded } from '../src/core/errors';

afterEach(() => {
  vi.unstubAllGlobals();
});

await configureGoFixture();

/** 等待任务终态；引擎不可用时按 kind 同步执行 */
async function ensureJobDone(cookie: string, jobId: string, kind: 'parse' | 'agent'): Promise<{ status: string; result: unknown; error: unknown }> {
  for (let i = 0; i < 20; i++) {
    const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
    if (res.status === 200) {
      const data = (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
      if (['succeeded', 'failed', 'waiting_input'].includes(data.status)) return data;
    } else {
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (kind === 'parse') await runParseJob(env, jobId);
  else await runAgentJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  return (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
}

async function createMaterial(cookie: string, pid: string, title: string, markdown?: string): Promise<{ materialId: string; revision: number; versionId: string }> {
  const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const material = (await create.json() as { data: { materialId: string; revision: number; currentVersion: { versionId: string } | null } }).data;
  if (!markdown) {
    return { materialId: material.materialId, revision: material.revision, versionId: material.currentVersion!.versionId };
  }
  const save = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: material.revision, doc: markdownToDoc(markdown) }),
  });
  expect(save.status).toBe(201);
  const saved = (await save.json()) as { data: { versionId: string; revision: number } };
  return { materialId: material.materialId, revision: saved.data.revision, versionId: saved.data.versionId };
}

describe('AI 会话索引', () => {
  it('列表支持游标恢复，并返回最新运行关联的 jobId', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const sessionIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const sessionId = crypto.randomUUID();
      sessionIds.push(sessionId);
      const createdAt = new Date(Date.UTC(2026, 8, 30, 0, 0, index)).toISOString();
      await env.DB.prepare(
        "INSERT INTO agent_sessions (id, project_id, capability, title, status, created_by, created_at, updated_at) VALUES (?1, ?2, 'do', ?3, 'active', ?4, ?5, ?5)",
      ).bind(sessionId, pid, `会话 ${index}`, owner.userId, createdAt).run();
    }

    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO agent_runs (id, session_id, project_id, capability, job_id, mode, status, inputs_json, prompt_version, created_at) VALUES (?1, ?2, ?3, 'do', ?4, 'do', 'running', '{}', 'test', ?5)",
    ).bind(runId, sessionIds[0], pid, jobId, new Date(Date.UTC(2026, 8, 30, 0, 0, 10)).toISOString()).run();

    const first = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions?status=all&limit=100`, { headers: { cookie } });
    expect(first.status).toBe(200);
    const allItems = ((await first.json()) as { data: { items: Array<{ sessionId: string; latestRunId: string | null; latestJobId: string | null }>; nextCursor: string | null } }).data.items;
    const latest = allItems.find((item) => item.sessionId === sessionIds[0]);
    expect(latest?.latestRunId).toBe(runId);
    expect(latest?.latestJobId).toBe(jobId);

    const allIds = allItems.map((item) => item.sessionId);
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`${BASE}/api/v1/projects/${pid}/agent-sessions?status=all&limit=2`);
      if (cursor) url.searchParams.set('cursor', cursor);
      const page = await SELF.fetch(url, { headers: { cookie } });
      expect(page.status).toBe(200);
      const pageData = (await page.json()) as { data: { items: { sessionId: string }[]; nextCursor: string | null } };
      pagedIds.push(...pageData.data.items.map((item) => item.sessionId));
      cursor = pageData.data.nextCursor;
    } while (cursor);
    expect(allIds).toHaveLength(5);
    expect(pagedIds).toEqual(allIds);
  });
});

describe('三档 AI 补位', () => {
  it('代做：生成草稿 → 可采纳为材料新版本（reviewed 语义强制）', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const material = await createMaterial(authCookie(owner.token), pid, '作品介绍', '# 作品介绍\n\n本作品面向组队作业场景。');

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ mode: 'do', instruction: '写作品介绍初稿', materialVersionIds: [material.versionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { sessionId: string; runId: string; jobId: string } };

    const list = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions?limit=100`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const listItems = ((await list.json()) as { data: { items: Array<{ sessionId: string; latestRunId: string | null; latestJobId: string | null }> } }).data.items;
    const listedSession = listItems.find((item) => item.sessionId === created.data.sessionId);
    expect(listedSession?.latestRunId).toBe(created.data.runId);
    expect(listedSession?.latestJobId).toBe(created.data.jobId);

    const done = await ensureJobDone(authCookie(owner.token), created.data.jobId, 'agent');
    expect(done.status).toBe('succeeded');

    const session = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions/${created.data.sessionId}`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const sessionBody = (await session.json()) as { data: { turns: Array<{ role: string; kind: string; payload: { markdown?: string } }> } };
    const draftTurn = sessionBody.data.turns.find((t) => t.kind === 'draft');
    expect(draftTurn?.payload.markdown).toContain('# AI 草稿');

    // 采纳：reviewed=false → 400
    const badAdopt = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${created.data.runId}/adopt`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ materialId: material.materialId, expectedRevision: material.revision, reviewed: false, doc: markdownToDoc('# 人工修改后') }),
    });
    expect(badAdopt.status).toBe(400);

    // 采纳成功 → 新版本 ai_adoption
    const adopt = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${created.data.runId}/adopt`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ materialId: material.materialId, expectedRevision: material.revision, reviewed: true, doc: markdownToDoc('# 人工修改后的作品介绍') }),
    });
    expect(adopt.status).toBe(201);
    const adopted = (await adopt.json()) as { data: { materialVersionId: string; revision: number } };
    expect(adopted.data.revision).toBe(material.revision + 1);

    // 版本 origin 与运行状态
    const version = await env.DB.prepare('SELECT origin, ai_run_id FROM material_versions WHERE id = ?1')
      .bind(adopted.data.materialVersionId)
      .first<{ origin: string; ai_run_id: string }>();
    expect(version?.origin).toBe('ai_adoption');
    const run = await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?1").bind(created.data.runId).first<{ status: string }>();
    expect(run?.status).toBe('adopted');

    // 重复采纳 → 409
    const again = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${created.data.runId}/adopt`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ materialId: material.materialId, expectedRevision: material.revision + 1, reviewed: true, doc: markdownToDoc('# 再采纳') }),
    });
    expect(again.status).toBe(409);

    // 账本事件
    const event = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'material.adopted'").first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it('只审：引文与材料不符 → AI_OUTPUT_INVALID；一致 → review_result', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch({ fabricatedAgentQuote: true }));
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const material = await createMaterial(authCookie(owner.token), pid, '作品介绍', '# 作品介绍\n\n本作品面向组队作业场景。');

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ mode: 'review_only', materialVersionIds: [material.versionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { sessionId: string; runId: string; jobId: string } };
    // 该分支 mock 返回不存在的引文 → 任务失败
    const done = await ensureJobDone(authCookie(owner.token), created.data.jobId, 'agent');
    expect(done.status).toBe('queued'); // Invalid evidence remains a failed attempt with pending recovery.
    expect((done.error as { code: string }).code).toBe('AI_OUTPUT_INVALID');
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(created.data.jobId).first<{status:string}>())?.status).toBe('failed');

    // 伪造引文关闭后（默认 mock 引文存在）→ 成功产生 review_result 回合
    vi.stubGlobal('fetch', mockGatewayFetch());
    const create2 = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ mode: 'review_only', materialVersionIds: [material.versionId] }),
    });
    const created2 = (await create2.json()) as { data: { sessionId: string; jobId: string } };
    const done2 = await ensureJobDone(authCookie(owner.token), created2.data.jobId, 'agent');
    expect(done2.status).toBe('succeeded');
    const session = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions/${created2.data.sessionId}`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const sessionBody = (await session.json()) as { data: { turns: Array<{ kind: string; payload: { issues?: unknown[] } }> } };
    expect(sessionBody.data.turns.find((t) => t.kind === 'review_result')?.payload.issues).toHaveLength(1);
  });

  it('带做：提问 → 回答 → 下一轮；历史完整保留', async () => {
    const fetchMock = mockGatewayFetch();
    vi.stubGlobal('fetch', fetchMock);
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ mode: 'guide', instruction: '带我做预审准备' }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { sessionId: string; jobId: string } };
    await ensureJobDone(authCookie(owner.token), created.data.jobId, 'agent');

    // 回答第一问 → 触发第二轮
    const turn = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions/${created.data.sessionId}/turns`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ content: '截止日期 2026-10-08，队伍五人以内。' }),
    });
    expect(turn.status).toBe(202);
    const turnBody = (await turn.json()) as { data: { sequence: number; jobId: string } };
    expect(turnBody.data.sequence).toBe(2);
    await ensureJobDone(authCookie(owner.token), turnBody.data.jobId, 'agent');

    const session = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions/${created.data.sessionId}`, {
      headers: { cookie: authCookie(owner.token) },
    });
    const sessionBody = (await session.json()) as { data: { turns: Array<{ sequence: number; role: string; kind: string }> } };
    const roles = sessionBody.data.turns.map((t) => `${t.sequence}:${t.role}:${t.kind}`);
    expect(roles).toEqual(['1:assistant:question', '2:user:answer', '3:assistant:question']);
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-opencode-session')))
      .toEqual([`integration:${created.data.sessionId}`, `integration:${created.data.sessionId}`]);
  });

  it('输入归属校验：引用他项目材料 → 404', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const other = await seedUser();
    const pid = await seedProject(owner.userId);
    const otherMaterial = await createMaterial(authCookie(other.token), await seedProject(other.userId), '别人的材料');

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ mode: 'do', materialVersionIds: [otherMaterial.versionId] }),
    });
    expect(create.status).toBe(404);
  });
});

describe('幂等（Idempotency-Key）', () => {
  it('冻结写请求缺少 Idempotency-Key → 400', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'do', instruction: '缺少幂等键' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('同键同内容回放同一会话；同键不同内容 409', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const key = crypto.randomUUID();
    const body = JSON.stringify({ mode: 'do', instruction: '幂等测试' });

    const first = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': key },
      body,
    });
    expect(first.status).toBe(202);
    const firstData = ((await first.json()) as { data: { sessionId: string } }).data;

    const second = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': key },
      body,
    });
    expect(second.status).toBe(202);
    expect(((await second.json()) as { data: { sessionId: string } }).data.sessionId).toBe(firstData.sessionId);

    const third = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ mode: 'do', instruction: '完全不同的内容' }),
    });
    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('预算并发预占（每项目 2）', () => {
  it('第 3 个并发预占被拒绝；结算后可再预占', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    await reserveAiSlot(env, { projectId: pid, jobId: `job-1-${pid}`, purpose: 'agent_run' });
    await reserveAiSlot(env, { projectId: pid, jobId: `job-2-${pid}`, purpose: 'agent_run' });
    let rejected = false;
    try {
      await reserveAiSlot(env, { projectId: pid, jobId: `job-3-${pid}`, purpose: 'agent_run' });
    } catch (err) {
      rejected = true;
      expect((err as { code?: string }).code).toBe('QUOTA_EXCEEDED');
    }
    expect(rejected).toBe(true);
    await settleReservation(env, `job-1-${pid}`, 'settled');
    await reserveAiSlot(env, { projectId: pid, jobId: `job-4-${pid}`, purpose: 'agent_run' });
  });

  it('并发预占原子限制在 2 个；清理只释放超过 2 小时的记录', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const concurrent = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => reserveAiSlot(env, {
        projectId: pid,
        jobId: `parallel-${index}-${pid}`,
        purpose: 'agent_run',
      })),
    );
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(3);

    const now = '2026-09-30T12:00:00.000Z';
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO usage_reservations (id, project_id, job_id, purpose, estimated_cost, status, created_at) VALUES (?1, ?2, 'stale', 'agent_run', 0, 'reserved', '2026-09-30T09:59:59.000Z')",
      ).bind(crypto.randomUUID(), pid),
      env.DB.prepare(
        "INSERT INTO usage_reservations (id, project_id, job_id, purpose, estimated_cost, status, created_at) VALUES (?1, ?2, 'fresh', 'agent_run', 0, 'reserved', '2026-09-30T10:00:01.000Z')",
      ).bind(crypto.randomUUID(), pid),
    ]);
    await releaseStaleReservations(env, now);
    const rows = await env.DB.prepare("SELECT job_id, status, settled_at FROM usage_reservations WHERE project_id = ?1 AND job_id IN ('stale', 'fresh') ORDER BY job_id")
      .bind(pid)
      .all<{ job_id: string; status: string; settled_at: string | null }>();
    expect(rows.results).toEqual([
      { job_id: 'fresh', status: 'reserved', settled_at: null },
      { job_id: 'stale', status: 'released', settled_at: now },
    ]);
  });

  it('仍在运行的任务预占不被清理释放', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const now = '2026-09-30T12:00:00.000Z';
    const stale = new Date(Date.parse(now) - 3 * 3600_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) VALUES ('running-job', ?1, 'agent_run', 'running', '{}', 0, ?2, ?3, ?3)",
      ).bind(pid, owner.userId, stale),
      env.DB.prepare(
        "INSERT INTO usage_reservations (id, project_id, job_id, purpose, estimated_cost, status, created_at) VALUES (?1, ?2, 'running-job', 'agent_run', 0, 'reserved', ?3)",
      ).bind(crypto.randomUUID(), pid, stale),
    ]);
    await releaseStaleReservations(env, now);
    const row = await env.DB.prepare("SELECT status FROM usage_reservations WHERE job_id = 'running-job'").first<{ status: string }>();
    expect(row?.status).toBe('reserved');
  });

  it('项目 AI 预算不足时拒绝预占并返回预算明细', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const configRow = await env.DB.prepare('SELECT id, config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1')
      .first<{ id: string; config_json: string }>();
    const priced = JSON.parse(configRow!.config_json) as Record<string, { pricePerMTokens: [number, number] | null }>;
    for (const purpose of ['textEconomy', 'visionEconomy', 'review'] as const) priced[purpose]!.pricePerMTokens = [1_000_000, 1_000_000];
    await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1')
      .bind(configRow!.id, JSON.stringify(priced))
      .run();
    try {
      await env.DB.prepare('UPDATE projects SET ai_budget_usd = 0.000001 WHERE id = ?1').bind(pid).run();
      let error: unknown;
      try {
        await reserveAiSlot(env, { projectId: pid, jobId: `over-budget-${pid}`, purpose: 'agent_run' });
      } catch (err) {
        error = err;
      }
      expect((error as { code?: string } | undefined)?.code).toBe('QUOTA_EXCEEDED');
      expect((error as { details?: { budgetUsd?: number } } | undefined)?.details?.budgetUsd).toBe(0.000001);
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE job_id = ?1").bind(`over-budget-${pid}`).first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1')
        .bind(configRow!.id, configRow!.config_json)
        .run();
    }
  });

  it('结算按真实用量写入金额，费用未知时标记待对账', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const configRow = await env.DB.prepare('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ id: string }>();

    await reserveAiSlot(env, { projectId: pid, jobId: 'job-known-cost', purpose: 'agent_run' });
    await env.DB.prepare(
      "INSERT INTO ai_calls (id, project_id, job_id, purpose, config_version_id, prompt_version, model, cost_usd, cost_status, status, created_at) VALUES (?1, ?2, 'job-known-cost', 'textEconomy', ?3, 'v1', 'm', 0.5, 'known', 'ok', ?4)",
    ).bind(crypto.randomUUID(), pid, configRow!.id, new Date(Date.now() + 1000).toISOString()).run();
    await settleReservation(env, 'job-known-cost', 'settled');
    const known = await env.DB.prepare("SELECT status, settled_cost FROM usage_reservations WHERE job_id = 'job-known-cost'").first<{ status: string; settled_cost: number }>();
    expect(known?.status).toBe('settled');
    expect(known?.settled_cost).toBeCloseTo(0.5);

    await reserveAiSlot(env, { projectId: pid, jobId: 'job-unknown-cost', purpose: 'agent_run' });
    await env.DB.prepare(
      "INSERT INTO ai_calls (id, project_id, job_id, purpose, config_version_id, prompt_version, model, cost_usd, cost_status, status, created_at) VALUES (?1, ?2, 'job-unknown-cost', 'textEconomy', ?3, 'v1', 'm', NULL, 'unknown', 'timeout', ?4)",
    ).bind(crypto.randomUUID(), pid, configRow!.id, new Date(Date.now() + 1000).toISOString()).run();
    await settleReservation(env, 'job-unknown-cost', 'settled');
    const unknown = await env.DB.prepare("SELECT status, settled_cost FROM usage_reservations WHERE job_id = 'job-unknown-cost'").first<{ status: string; settled_cost: number | null }>();
    expect(unknown?.status).toBe('pending_reconcile');
    expect(unknown?.settled_cost).toBeNull();
  });
});
