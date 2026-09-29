import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runAgentJob } from '../src/services/agent';
import { runParseJob } from '../src/services/parse';
import { reserveAiSlot, settleReservation } from '../src/services/budget';
import { markdownToDoc } from '../src/services/tiptap';
import { quotaExceeded } from '../src/core/errors';

afterEach(() => {
  vi.unstubAllGlobals();
});

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();

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
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ materialId: material.materialId, expectedRevision: material.revision, reviewed: false, doc: markdownToDoc('# 人工修改后') }),
    });
    expect(badAdopt.status).toBe(400);

    // 采纳成功 → 新版本 ai_adoption
    const adopt = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${created.data.runId}/adopt`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
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
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
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
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'review_only', materialVersionIds: [material.versionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { sessionId: string; runId: string; jobId: string } };
    // 该分支 mock 返回不存在的引文 → 任务失败
    const done = await ensureJobDone(authCookie(owner.token), created.data.jobId, 'agent');
    expect(done.status).toBe('failed');
    expect((done.error as { code: string }).code).toBe('AI_OUTPUT_INVALID');

    // 伪造引文关闭后（默认 mock 引文存在）→ 成功产生 review_result 回合
    vi.stubGlobal('fetch', mockGatewayFetch());
    const create2 = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
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
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
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
  });

  it('输入归属校验：引用他项目材料 → 404', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const other = await seedUser();
    const pid = await seedProject(owner.userId);
    const otherMaterial = await createMaterial(authCookie(other.token), await seedProject(other.userId), '别人的材料');

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'do', materialVersionIds: [otherMaterial.versionId] }),
    });
    expect(create.status).toBe(404);
  });
});

describe('幂等（Idempotency-Key）', () => {
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
});
