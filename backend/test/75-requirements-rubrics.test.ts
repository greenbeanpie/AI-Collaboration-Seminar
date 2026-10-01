import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runParseJob } from '../src/services/parse';

afterEach(() => {
  vi.unstubAllGlobals();
});

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();

async function parsePasteSource(cookie: string, pid: string): Promise<string> {
  const src = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'paste', text: '通知：作品提交截止 2026-10-08，队伍最多 5 人，须提交申报书 PDF、介绍视频 MP4，评审按 20/25/20/25/10 权重。' }),
  });
  const { sourceId } = (await src.json() as { data: { sourceId: string } }).data;
  const parse = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/parse`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const jobId = ((await parse.json()) as { data: { jobId: string } }).data.jobId;
  for (let i = 0; i < 20; i++) {
    const done = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?1').bind(jobId).first<{ status: string }>();
    if (done?.status && ['succeeded', 'failed', 'waiting_input'].includes(done.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const job = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?1').bind(jobId).first<{ status: string }>();
  if (job?.status === 'queued') await runParseJob(env, jobId);
  const final = await env.DB.prepare('SELECT status, result_json FROM jobs WHERE id = ?1').bind(jobId).first<{ status: string; result_json: string | null }>();
  expect(final?.status).toBe('succeeded');
  return (JSON.parse(final!.result_json!) as { requirementSetId: string }).requirementSetId;
}

describe('要求集：编辑与确认', () => {
  it('成员可编辑草稿条目；确认需 owner；已确认不可改', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const member = await seedUser();
    const pid = await seedProject(owner.userId);
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'member', '2026-09-29T00:00:00.000Z')",
    )
      .bind(crypto.randomUUID(), pid, member.userId)
      .run();
    const setId = await parsePasteSource(authCookie(owner.token), pid);

    // 详情含要求条目
    const detail = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirement-sets/${setId}`, {
      headers: { cookie: authCookie(member.token) },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json() as { data: { status: string; requirements: Array<{ requirementId: string; fieldState: string }> } }).data;
    expect(detailBody.status).toBe('draft');
    expect(detailBody.requirements.length).toBeGreaterThan(0);
    const first = detailBody.requirements[0]!;
    expect(first.fieldState).toBe('ai_suggestion');

    // 成员编辑条目 → edited
    const patch = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirements/${first.requirementId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(member.token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '人工修改后的标题', detail: '经人工核对' }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { data: { fieldState: string } }).data.fieldState).toBe('edited');

    const setDueDate = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirements/${first.requirementId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(member.token), 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: '2026-10-08' }),
    });
    expect(setDueDate.status).toBe(200);
    expect(((await setDueDate.json()) as { data: { dueDate: string | null } }).data.dueDate).toBe('2026-10-08');

    const clearDueDate = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirements/${first.requirementId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(member.token), 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: null }),
    });
    expect(clearDueDate.status).toBe(200);
    expect(((await clearDueDate.json()) as { data: { dueDate: string | null } }).data.dueDate).toBeNull();

    // 成员不能确认
    const memberConfirm = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirement-sets/${setId}/confirm`, {
      method: 'POST',
      headers: { cookie: authCookie(member.token) },
    });
    expect(memberConfirm.status).toBe(403);

    // owner 确认 → confirmed；重复确认 409；确认后条目不可改
    const confirm = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirement-sets/${setId}/confirm`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(confirm.status).toBe(200);
    expect(((await confirm.json()) as { data: { status: string } }).data.status).toBe('confirmed');

    const again = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirement-sets/${setId}/confirm`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(again.status).toBe(409);

    const patchAfter = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/requirements/${first.requirementId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '再改' }),
    });
    expect(patchAfter.status).toBe(409);

    const notifications = await SELF.fetch(`${BASE}/api/v1/notifications`, { headers: { cookie: authCookie(member.token) } });
    const events = (await notifications.json() as { data: { items: { kind: string; body: string }[] } }).data.items;
    expect(events.filter(event => event.kind === 'requirements_ready')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'requirements_confirmed')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'requirement_changed')).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain('人工修改后的标题');
  });
});

describe('评分标准版本', () => {
  it('创建版本递增、草稿可改、确认后锁定', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const weights = [
      { key: 'theme', label: '主题契合', weight: 20 },
      { key: 'innovation', label: '创新性', weight: 25 },
      { key: 'plan', label: '方案', weight: 20 },
      { key: 'effect', label: '成效', weight: 25 },
      { key: 'demo', label: '演示', weight: 10 },
    ];

    const create1 = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'official', weights, notes: '本赛事官方权重（非官方模拟展示）' }),
    });
    expect(create1.status).toBe(201);
    const rubric1 = ((await create1.json()) as { data: { rubricId: string; version: number } }).data;
    expect(rubric1.version).toBe(1);

    const create2 = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'custom', weights }),
    });
    expect((((await create2.json()) as { data: { version: number } }).data).version).toBe(2);

    const patch = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics/${rubric1.rubricId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: '补充细则说明' }),
    });
    expect(patch.status).toBe(200);

    const clearNotes = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics/${rubric1.rubricId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: null }),
    });
    expect(clearNotes.status).toBe(200);
    expect(((await clearNotes.json()) as { data: { notes: string | null } }).data.notes).toBeNull();

    const confirm = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics/${rubric1.rubricId}/confirm`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token) },
    });
    expect(confirm.status).toBe(200);

    const patchAfter = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rubrics/${rubric1.rubricId}`, {
      method: 'PATCH',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: '再改' }),
    });
    expect(patchAfter.status).toBe(409);
  });
});
