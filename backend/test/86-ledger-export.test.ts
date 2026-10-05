import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

describe('活动历史与导出', () => {
  it('移除手工账本接口，保留历史事件分页与导出汇总', async () => {
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

    // Historic events survive even though their manual entry APIs are gone.
    await env.DB.prepare("INSERT INTO events (id, project_id, type, actor_type, actor_id, entity_type, entity_id, payload_json, occurred_at) VALUES (?1,?2,'decision.recorded','user',?3,'decision',?4,'{}',?5)").bind(crypto.randomUUID(), pid, owner.userId, crypto.randomUUID(), createdAt).run();
    for (const path of ['decisions', 'contributions', `contributions/${crypto.randomUUID()}/corrections`, 'resources']) {
      for (const method of ['GET', 'POST']) {
        const response = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/${path}`, { method, headers: { ...json, cookie }, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(response.status).toBe(404);
      }
    }
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('decisions','contributions','resource_references')").all();
    expect(tables.results).toEqual([]);
    await env.DB.prepare("INSERT INTO events (id, project_id, type, actor_type, actor_id, entity_type, entity_id, payload_json, occurred_at) VALUES (?1,?2,'task.created','user',?3,'task',?4,'{}','2020-01-01T00:00:00.000Z')").bind(crypto.randomUUID(), pid, owner.userId, crypto.randomUUID()).run();
    const events = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/events?limit=1`, { headers: { cookie } });
    expect(events.status).toBe(200);
    const eventPage = (await events.json()) as { data: { items: Array<{ type: string }>; nextCursor: string | null } };
    expect(eventPage.data.items).toHaveLength(1);
    expect(eventPage.data.items[0]!.type).toBe('decision.recorded');
    expect(eventPage.data.nextCursor).not.toBeNull();
    const nextPage = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/events?limit=1&cursor=${encodeURIComponent(eventPage.data.nextCursor!)}`, { headers: { cookie } });
    expect(nextPage.status).toBe(200);
    expect((await nextPage.json() as { data: { items: Array<{ type: string }>; nextCursor: string | null } }).data).toMatchObject({ items: [{ type: 'task.created' }], nextCursor: null });

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
        aiUsage: { calls: number; promptTokens: number; completionTokens: number };
      };
    };
    for (const key of ['decisions', 'contributions', 'resources']) expect(bundleBody.data).not.toHaveProperty(key);
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
    expect(bundleBody.data.aiUsage).not.toHaveProperty('costStatus');
  });
});
