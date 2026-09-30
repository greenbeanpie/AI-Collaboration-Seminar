import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runParseJob } from '../src/services/parse';
import { runAgentJob } from '../src/services/agent';

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A14 本地零费用端到端（真实 D1/R2/Workflow 代码路径，模型走受控 fixture）', () => {
  it('来源解析 → 要求确认 → AI 代做 → 采纳 → 导出汇总全链路可用', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const p = `/api/v1/projects/${pid}`;
    const post = (path: string, body?: unknown, status = 201) => SELF.fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      expect(res.status, `POST ${path}: ${await res.clone().text()}`).toBe(status);
      return res.json() as Promise<{ data: any }>;
    });
    const get = async (path: string) => {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: { cookie } });
      expect(res.status, `GET ${path}: ${await res.clone().text()}`).toBe(200);
      return (await res.json() as { data: any }).data;
    };

    // 1) 导入通知
    const source = (await post(`${p}/sources`, { kind: 'paste', title: '比赛通知', text: '比赛通知：参赛作品提交截止日期为 2026 年 10 月 8 日，需提交申报书 PDF 与作品介绍。' })).data;

    // 2) 解析 → 要求草稿（真实 AI 调用路径，模型为受控 fixture）
    const parse = (await post(`${p}/sources/${source.sourceId}/parse`, {}, 202)).data;
    let job: any;
    for (let i = 0; i < 20; i++) {
      job = await get(`/api/v1/jobs/${parse.jobId}`);
      if (['succeeded', 'failed', 'waiting_input'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!['succeeded', 'failed', 'waiting_input'].includes(job?.status ?? '')) {
      await runParseJob(env, parse.jobId);
      job = await get(`/api/v1/jobs/${parse.jobId}`);
    }
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');

    const sets = await get(`${p}/requirement-sets`);
    expect(sets.items.length).toBeGreaterThan(0);
    const setId = sets.items[0].requirementSetId;
    const requirement = (await get(`${p}/requirement-sets/${setId}`)).requirements[0];
    expect(requirement.citations.length).toBeGreaterThan(0);

    // 3) 负责人确认要求
    await post(`${p}/requirement-sets/${setId}/confirm`, undefined, 200);

    // 4) 材料
    const material = (await post(`${p}/materials`, { title: '作品介绍' })).data;

    // 5) AI 代做
    const session = (await post(`${p}/agent-sessions`, { mode: 'do', instruction: '写作品介绍初稿', materialVersionIds: [material.currentVersion.versionId] }, 202)).data;
    let agentJob: any;
    for (let i = 0; i < 20; i++) {
      agentJob = await get(`/api/v1/jobs/${session.jobId}`);
      if (['succeeded', 'failed'].includes(agentJob.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!['succeeded', 'failed'].includes(agentJob?.status ?? '')) {
      await runAgentJob(env, session.jobId);
      agentJob = await get(`/api/v1/jobs/${session.jobId}`);
    }
    expect(agentJob.status, JSON.stringify(agentJob.error)).toBe('succeeded');

    // 6) 人工复核后采纳为正式版本
    const adopted = (await post(`${p}/agent-runs/${session.runId}/adopt`, {
      materialId: material.materialId,
      expectedRevision: material.revision,
      reviewed: true,
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '人工复核后的作品介绍正文' }] }] },
    })).data;
    expect(adopted.revision).toBe(material.revision + 1);

    // 7) 导出汇总包含材料正文与要求集
    const bundle = await get(`${p}/export-bundle`);
    expect(bundle.materials[0].markdown).toContain('人工复核后的作品介绍正文');
    expect(bundle.requirementSets.length).toBeGreaterThan(0);
    expect(JSON.stringify(bundle)).toContain('2026-10-08');
  });
});
