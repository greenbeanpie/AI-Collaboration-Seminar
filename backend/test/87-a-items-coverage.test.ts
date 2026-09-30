import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runParseJob } from '../src/services/parse';

await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();

afterEach(() => {
  vi.unstubAllGlobals();
});

async function waitJobDone(cookie: string, jobId: string): Promise<{ status: string; error: unknown }> {
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
  await runParseJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  return (await res.json() as { data: { status: string; error: unknown } }).data;
}

async function uploadFile(cookie: string, pid: string, fileName: string, bytes = new TextEncoder().encode('附件内容')): Promise<string> {
  const init = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/files`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });
  const initData = (await init.json() as { data: { fileId: string; upload: { url: string } } }).data;
  const put = await SELF.fetch(`${BASE}${initData.upload.url}`, { method: 'PUT', headers: { cookie }, body: bytes });
  expect(put.status).toBe(201);
  return initData.fileId;
}

describe('A10 来源全文片段定位', () => {
  it('可列出可引用片段、支持游标分页，并拒绝跨项目读取', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const source = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'paste', title: '来源全文', text: '请在 2026 年 10 月 8 日前提交作品介绍 PDF，团队人数不超过 5 人。' }),
    });
    const { sourceId, sourceVersionId } = (await source.json() as { data: { sourceId: string; sourceVersionId: string } }).data;
    const parse = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/parse`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const jobId = (await parse.json() as { data: { jobId: string } }).data.jobId;
    expect((await waitJobDone(cookie, jobId)).status).toBe('succeeded');

    const listUrl = `${BASE}/api/v1/projects/${pid}/sources/${sourceId}/versions/${sourceVersionId}/fragments`;
    const all = await SELF.fetch(`${listUrl}?limit=100`, { headers: { cookie } });
    expect(all.status).toBe(200);
    const items = (await all.json() as { data: { items: Array<{ fragmentId: string; content: string; seq: number; pageNumber: number | null }>; nextCursor: string | null } }).data.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.fragmentId).toBeTruthy();
    expect(items[0]?.content.length).toBeGreaterThan(0);

    // 游标分页不重复
    const page1 = await SELF.fetch(`${listUrl}?limit=1`, { headers: { cookie } });
    const first = (await page1.json() as { data: { items: Array<{ fragmentId: string }>; nextCursor: string | null } }).data;
    expect(first.items).toHaveLength(1);
    if (first.nextCursor) {
      const page2 = await SELF.fetch(`${listUrl}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { cookie } });
      const second = (await page2.json() as { data: { items: Array<{ fragmentId: string }> } }).data;
      expect(second.items[0]?.fragmentId).not.toBe(first.items[0]?.fragmentId);
    }

    // 非成员不可读（跨项目隔离）：项目作用域接口由 requireProjectMember 返回 403
    const outsider = await seedUser();
    await seedProject(outsider.userId);
    const denied = await SELF.fetch(listUrl, { headers: { cookie: authCookie(outsider.token) } });
    expect(denied.status).toBe(403);

    // 非法游标被拒绝
    const badCursor = await SELF.fetch(`${listUrl}?cursor=abc`, { headers: { cookie } });
    expect(badCursor.status).toBe(400);
  });
});

describe('A09 材料附件与作品介绍模板', () => {
  it('附件绑定到版本、随导出一并返回，且拒绝跨项目附件', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const fileId = await uploadFile(cookie, pid, '证据附件.txt');

    const created = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '作品介绍', kind: 'work-introduction' }),
    });
    const material = (await created.json() as { data: { materialId: string; revision: number; currentVersion: { doc: unknown; markdown: string; attachments: unknown[] } } }).data;
    expect(material.currentVersion.markdown).toContain('实现与验证');

    const saved = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: material.revision, doc: material.currentVersion.doc, attachmentIds: [fileId] }),
    });
    expect(saved.status).toBe(201);
    const version = (await saved.json() as { data: { attachments: Array<{ fileId: string; name: string }> } }).data;
    expect(version.attachments).toEqual([{ fileId, name: '证据附件.txt' }]);

    const bundle = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/export-bundle`, { headers: { cookie } });
    const exported = (await bundle.json() as { data: { materials: Array<{ attachments: Array<{ fileId: string }> }> } }).data;
    expect(exported.materials[0]?.attachments.map((a) => a.fileId)).toContain(fileId);

    // 跨项目附件必须被拒绝
    const outsider = await seedUser();
    const otherPid = await seedProject(outsider.userId);
    const foreignFile = await uploadFile(authCookie(outsider.token), otherPid, '别人的附件.txt');
    const rejected = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/materials/${material.materialId}`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: material.revision + 1, doc: material.currentVersion.doc, attachmentIds: [foreignFile] }),
    });
    expect(rejected.status).toBe(404);
  });
});

describe('A11 答辩历史跨设备列表', () => {
  it('项目成员可列出历史（空列表带游标契约），非成员被拒绝', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const list = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals?limit=20`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json() as { data: { items: unknown[]; nextCursor: string | null } }).data;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.nextCursor).toBeNull();

    const outsider = await seedUser();
    await seedProject(outsider.userId);
    const denied = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/rehearsals`, { headers: { cookie: authCookie(outsider.token) } });
    expect(denied.status).toBe(403);
  });
});
