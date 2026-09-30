import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

describe('过程账本与导出', () => {
  it('决策/贡献/更正/资源声明 + 事件流 + 导出汇总', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const json = { 'content-type': 'application/json' };
    const createdAt = new Date().toISOString();
    const requirementSetId = crypto.randomUUID();
    const requirementId = crypto.randomUUID();
    const sourceVersionId = crypto.randomUUID();
    const fragmentId = crypto.randomUUID();
    const rubricId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO requirement_sets (id, project_id, status, revision, confirmed_by, confirmed_at, created_at, updated_at) VALUES (?1, ?2, 'confirmed', 2, ?3, ?4, ?4, ?4)")
        .bind(requirementSetId, pid, owner.userId, createdAt),
      env.DB.prepare("INSERT INTO requirements (id, requirement_set_id, project_id, seq, category, title, detail, due_date, due_precision, citations_json, field_state, updated_at) VALUES (?1, ?2, ?3, 1, 'deadline', '报名截止', '', '2026-10-08', 'date', ?4, 'confirmed', ?5)")
        .bind(requirementId, requirementSetId, pid, JSON.stringify([{ sourceVersionId, fragmentId, pageNumber: 1, quote: '截止日期' }]), createdAt),
      env.DB.prepare("INSERT INTO rubric_versions (id, project_id, version, source, weights_json, notes, status, confirmed_by, confirmed_at, created_at) VALUES (?1, ?2, 1, 'official', ?3, '比赛官方权重', 'confirmed', ?4, ?5, ?5)")
        .bind(rubricId, pid, JSON.stringify([{ key: 'innovation', label: '创新', weight: 20 }]), owner.userId, createdAt),
    ]);

    // 决策
    const decision = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/decisions`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ title: '采用三档 AI 补位', detail: '经组内讨论确认' }),
    });
    expect(decision.status).toBe(201);
    const decisions = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/decisions`, { headers: { cookie } });
    expect((((await decisions.json()) as { data: { items: unknown[] } }).data).items).toHaveLength(1);

    // 贡献 + 更正（原记录保留）
    const contribution = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/contributions`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'manual', description: '完成了通知解析联调' }),
    });
    expect(contribution.status).toBe(201);
    const contributionId = ((await contribution.json()) as { data: { contributionId: string } }).data.contributionId;
    const correction = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/contributions/${contributionId}/corrections`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ description: '更正：实为完成解析与预审联调' }),
    });
    expect(correction.status).toBe(201);
    const corrections = ((await correction.json()) as { data: { correctionOf: string } }).data;
    expect(corrections.correctionOf).toBe(contributionId);
    const contributions = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/contributions`, { headers: { cookie } });
    const contributionItems = ((await contributions.json()) as { data: { items: Array<{ kind: string }> } }).data.items;
    expect(contributionItems.map((c) => c.kind).sort()).toEqual(['correction', 'manual']);

    // 资源声明
    const resource = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/resources`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'url', title: '比赛官方通知', url: 'https://example.com/notice' }),
    });
    expect(resource.status).toBe(201);
    // url 类缺 url → 400
    const badResource = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/resources`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'url', title: '缺少地址' }),
    });
    expect(badResource.status).toBe(400);

    // 事件流（含决策事件与材料事件）
    const events = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/events`, { headers: { cookie } });
    const eventTypes = ((await events.json()) as { data: { items: Array<{ type: string }> } }).data.items.map((e) => e.type);
    expect(eventTypes).toContain('decision.recorded');

    // 导出
    const bundle = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/export-bundle`, { headers: { cookie } });
    expect(bundle.status).toBe(200);
    const bundleBody = (await bundle.json()) as {
      data: {
        project: { id: string; name: string };
        materials: unknown[];
        requirementSets: Array<{ requirementSetId: string; status: string; requirements: Array<{ requirementId: string; citations: Array<{ fragmentId: string }> }> }>;
        rubricVersions: Array<{ rubricId: string; status: string; weights: Array<{ key: string; weight: number }> }>;
        tasks: unknown[];
        decisions: unknown[];
        contributions: unknown[];
        resources: unknown[];
        aiUsage: { calls: number; costStatus: string };
      };
    };
    expect(bundleBody.data.project.id).toBe(pid);
    expect(bundleBody.data.requirementSets).toHaveLength(1);
    expect(bundleBody.data.requirementSets[0]).toMatchObject({
      requirementSetId,
      status: 'confirmed',
      requirements: [{ requirementId, citations: [{ sourceVersionId, fragmentId, pageNumber: 1, quote: '截止日期' }] }],
    });
    expect(bundleBody.data.rubricVersions).toEqual([{
      rubricId,
      version: 1,
      source: 'official',
      weights: [{ key: 'innovation', label: '创新', weight: 20 }],
      notes: '比赛官方权重',
      status: 'confirmed',
      confirmedAt: createdAt,
      createdAt,
    }]);
    expect(bundleBody.data.decisions).toHaveLength(1);
    expect(bundleBody.data.resources).toHaveLength(1);
    expect(bundleBody.data.aiUsage.costStatus).toBe('unknown');
  });
});
