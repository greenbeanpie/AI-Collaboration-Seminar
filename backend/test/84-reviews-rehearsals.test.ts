import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runAiJob } from '../src/services/ai-jobs';
import { markdownToDoc } from '../src/services/tiptap';

afterEach(() => {
  vi.unstubAllGlobals();
});

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();

async function ensureAiJobDone(cookie: string, jobId: string): Promise<{ status: string; result: unknown; error: unknown }> {
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
  await runAiJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  return (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
}

interface Setup {
  owner: { token: string; userId: string };
  pid: string;
  materialVersionId: string;
  rubricVersionId: string;
  requirementSetId: string;
}

/** 准备预审/答辩所需的材料、评分标准、要求集 */
async function setup(): Promise<Setup> {
  const owner = await seedUser();
  const pid = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);

  const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '作品介绍' }),
  });
  const material = (await create.json() as { data: { materialId: string; revision: number } }).data;
  const save = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: material.revision, doc: markdownToDoc('# 作品介绍\n\n本作品面向组队作业场景。') }),
  });
  const versionId = ((await save.json()) as { data: { versionId: string } }).data.versionId;

  const rubric = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'official',
      weights: [
        { key: 'theme', label: '主题契合', weight: 20 },
        { key: 'innovation', label: '创新性', weight: 25 },
      ],
    }),
  });
  const rubricVersionId = ((await rubric.json()) as { data: { rubricId: string } }).data.rubricId;

  // 通过解析产生要求集（mock AI）
  const src = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'paste', text: '通知：作品提交截止 2026-10-08，队伍最多五人，须提交申报书 PDF 与介绍视频 MP4，逾期不受理。' }),
  });
  const { sourceId } = (await src.json() as { data: { sourceId: string } }).data;
  const parse = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/parse`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const parseJobId = ((await parse.json()) as { data: { jobId: string } }).data.jobId;
  await ensureAiJobDone(cookie, parseJobId);
  const setRow = await env.DB.prepare('SELECT id FROM requirement_sets WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1')
    .bind(pid)
    .first<{ id: string }>();

  return { owner, pid, materialVersionId: versionId, rubricVersionId, requirementSetId: setRow!.id };
}

describe('预审', () => {
  it('发起 → 运行 → 报告覆盖全部评分维度', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const { owner, pid, materialVersionId, rubricVersionId, requirementSetId } = await setup();
    const cookie = authCookie(owner.token);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/reviews`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ rubricVersionId, requirementSetId, materialVersionIds: [materialVersionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { reviewId: string; jobId: string } };

    const done = await ensureAiJobDone(cookie, created.data.jobId);
    expect(done.status).toBe('succeeded');

    const detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/reviews/${created.data.reviewId}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { data: { status: string; report: { scores: Array<{ key: string; score: number }>; overall: { score: number }; materialVersionIds: string[] } } };
    expect(body.data.status).toBe('succeeded');
    expect(body.data.report.scores.map((s) => s.key).sort()).toEqual(['innovation', 'theme']);
    expect(body.data.report.overall.score).toBe(80);
    // 报告绑定明确输入版本
    expect(body.data.report.materialVersionIds).toEqual([materialVersionId]);

    // 输入不属于本项目 → 404
    const other = await seedUser();
    const otherSetup = await setup();
    void other;
    const bad = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/reviews`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ rubricVersionId, requirementSetId, materialVersionIds: [otherSetup.materialVersionId] }),
    });
    expect(bad.status).toBe(404);
  });
});

describe('答辩演练', () => {
  it('第一问 → 逐题回答 → 追问 → 总结收尾', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const { owner, pid, materialVersionId } = await setup();
    const cookie = authCookie(owner.token);

    const create = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', materialVersionIds: [materialVersionId] }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json()) as { data: { rehearsalId: string; jobId: string } };

    const firstDone = await ensureAiJobDone(cookie, created.data.jobId);
    expect(firstDone.status).toBe('succeeded');

    // 第一问
    let detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}`, { headers: { cookie } });
    let body = (await detail.json()) as { data: { status: string; turns: Array<{ sequence: number; kind: string; content: string }> } };
    expect(body.data.turns).toHaveLength(1);
    expect(body.data.turns[0]?.kind).toBe('question');

    // 回答 → 追问
    const answer = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}/answers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '痛点依据来自三份调研报告。' }),
    });
    expect(answer.status).toBe(202);
    const answerBody = (await answer.json()) as { data: { jobId: string } };
    await ensureAiJobDone(cookie, answerBody.data.jobId);

    // 结束 → 总结
    const finish = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}/finish`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(finish.status).toBe(202);
    const finishBody = (await finish.json()) as { data: { jobId: string } };
    await ensureAiJobDone(cookie, finishBody.data.jobId);

    detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}`, { headers: { cookie } });
    const finalBody = (await detail.json()) as { data: { status: string; turns: Array<{ kind: string }> } };
    expect(finalBody.data.status).toBe('finished');
    expect(finalBody.data.turns.map((t) => t.kind)).toEqual(['question', 'answer', 'followup', 'summary']);

    // 已结束的演练不能再答题
    const again = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals/${created.data.rehearsalId}/answers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '再答一次' }),
    });
    expect(again.status).toBe(409);
  });
});
