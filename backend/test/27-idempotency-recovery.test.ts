import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runAgentJob } from '../src/services/agent';
import { markdownToDoc } from '../src/services/tiptap';

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();

afterEach(() => {
  vi.unstubAllGlobals();
});

const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

async function ensureJobDone(cookie: string, jobId: string): Promise<{ status: string; error: unknown }> {
  for (let i = 0; i < 20; i++) {
    const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
    if (res.status === 200) {
      const data = (await res.json() as { data: { status: string; error: unknown } }).data;
      if (['succeeded', 'failed', 'waiting_input'].includes(data.status)) return data;
    } else {
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await runAgentJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  return (await res.json() as { data: { status: string; error: unknown } }).data;
}

async function createMaterial(cookie: string, pid: string): Promise<{ materialId: string; revision: number; versionId: string }> {
  const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '作品介绍' }),
  });
  const data = (await res.json() as { data: { materialId: string; revision: number; currentVersion: { versionId: string } } }).data;
  return { materialId: data.materialId, revision: data.revision, versionId: data.currentVersion.versionId };
}

async function succeededRun(cookie: string, pid: string, materialVersionId: string): Promise<{ runId: string; jobId: string }> {
  const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ mode: 'do', instruction: '写作品介绍初稿', materialVersionIds: [materialVersionId] }),
  });
  const created = (await res.json() as { data: { runId: string; jobId: string } }).data;
  const done = await ensureJobDone(cookie, created.jobId);
  expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
  return created;
}

async function counts(pid: string) {
  const versions = await env.DB.prepare('SELECT COUNT(*) AS n FROM material_versions WHERE project_id = ?1').bind(pid).first<{ n: number }>();
  const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?1 AND type = 'material.adopted'").bind(pid).first<{ n: number }>();
  return { versions: versions?.n ?? 0, adoptedEvents: events?.n ?? 0 };
}

describe('A08 幂等响应记录失败后的恢复语义', () => {
  it('业务成功但响应记录失败时：同键重试不重复建版本、不丢事件，可由运维释放后重试', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const material = await createMaterial(cookie, pid);
    const run = await succeededRun(cookie, pid, material.versionId);

    const key = `adopt-${crypto.randomUUID()}`;
    const body = JSON.stringify({
      materialId: material.materialId,
      expectedRevision: material.revision,
      reviewed: true,
      doc: markdownToDoc('# 人工修改后的作品介绍'),
    });
    const adoptHeaders = { cookie, 'content-type': 'application/json', 'idempotency-key': key };

    const first = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${run.runId}/adopt`, { method: 'POST', headers: adoptHeaders, body });
    expect(first.status).toBe(201);
    // 材料创建本身产生 1 个空版本，采纳再产生 1 个
    const afterFirst = await counts(pid);
    expect(afterFirst).toEqual({ versions: 2, adoptedEvents: 1 });

    // 模拟「业务已成功、响应记录写入失败」：把记录退回 processing 且清空回放响应
    await env.DB.prepare(
      "UPDATE idempotency_records SET status = 'processing', response_status = NULL, response_body = NULL WHERE idempotency_key = ?1",
    ).bind(key).run();

    const retry = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${run.runId}/adopt`, { method: 'POST', headers: adoptHeaders, body });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe('INVALID_STATE');
    // 核心保证：不重复建版本、不丢账本事件
    expect(await counts(pid)).toEqual(afterFirst);

    // 运维可见
    const stuck = await SELF.fetch(`${BASE}/api/v1/admin/idempotency/stuck?olderThanMinutes=0`, { headers: adminHeaders });
    expect(stuck.status).toBe(200);
    const stuckBody = (await stuck.json() as { data: { items: Array<{ idempotencyKey: string; operation: string; userId: string }> } }).data;
    const record = stuckBody.items.find((item) => item.idempotencyKey === key);
    expect(record?.operation).toBe('agent-run.adopt');

    // 运维释放后，同键可重新进入业务逻辑（此时运行已 adopted，仍不会重复建版本）
    const release = await SELF.fetch(`${BASE}/api/v1/admin/idempotency/release`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ idempotencyKey: key, userId: record!.userId, operation: 'agent-run.adopt' }),
    });
    expect(release.status).toBe(200);

    const afterRelease = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/agent-runs/${run.runId}/adopt`, { method: 'POST', headers: adoptHeaders, body });
    expect(afterRelease.status).toBe(409);
    expect(await counts(pid)).toEqual(afterFirst);
  });

  it('同键同内容正常回放：返回原响应且不产生新版本', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const material = await createMaterial(cookie, pid);
    const run = await succeededRun(cookie, pid, material.versionId);

    const key = `replay-${crypto.randomUUID()}`;
    const body = JSON.stringify({ materialId: material.materialId, expectedRevision: material.revision, reviewed: true, doc: markdownToDoc('# 回放') });
    const headers = { cookie, 'content-type': 'application/json', 'idempotency-key': key };
    const url = `${BASE}/api/v1/projects/${pid}/agent-runs/${run.runId}/adopt`;

    const first = await SELF.fetch(url, { method: 'POST', headers, body });
    expect(first.status).toBe(201);
    const firstBody = (await first.json() as { data: unknown }).data;

    const second = await SELF.fetch(url, { method: 'POST', headers, body });
    expect(second.status).toBe(201);
    expect((await second.json() as { data: unknown }).data).toEqual(firstBody);
    expect(await counts(pid)).toEqual({ versions: 2, adoptedEvents: 1 });
  });

  it('运维端点需要管理员令牌，未知记录返回 404', async () => {
    const anon = await SELF.fetch(`${BASE}/api/v1/admin/idempotency/stuck`);
    expect(anon.status).toBe(401);

    const missing = await SELF.fetch(`${BASE}/api/v1/admin/idempotency/release`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ idempotencyKey: 'no-such-key', userId: crypto.randomUUID(), operation: 'agent-run.adopt' }),
    });
    expect(missing.status).toBe(404);
  });
});
