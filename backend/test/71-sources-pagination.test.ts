import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

it('来源分页处理游标和同一时间戳，不丢失或重复来源', async () => {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'paste', title: `来源 ${index}`, text: '真实来源' }),
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { data: { sourceId: string } }).data.sourceId);
  }
  await env.DB.prepare('UPDATE sources SET created_at = ?1 WHERE project_id = ?2')
    .bind('2026-09-30T00:00:00.000Z', projectId).run();
  let cursor: string | null = null;
  const actual: string[] = [];
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const url = new URL(`${BASE}/api/v1/projects/${projectId}/sources?limit=2`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await SELF.fetch(url, { headers: { cookie } });
    expect(response.status).toBe(200);
    const page = ((await response.json()) as { data: { items: { sourceId: string }[]; nextCursor: string | null } }).data;
    actual.push(...page.items.map(item => item.sourceId));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(actual).toEqual(ids.sort().reverse());
});

it('来源版本的读取、解析和图片写入必须属于当前项目和来源', async () => {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const otherProjectId = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);
  async function source(project: string) {
    const response = await SELF.fetch(`${BASE}/api/v1/projects/${project}/sources`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'paste', text: '版本归属测试' }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { data: { sourceId: string; sourceVersionId: string } }).data;
  }
  const own = await source(projectId);
  const sameProjectOtherSource = await source(projectId);
  const foreign = await source(otherProjectId);
  for (const mismatched of [sameProjectOtherSource, foreign]) {
    const path = `${BASE}/api/v1/projects/${projectId}/sources/${own.sourceId}`;
    const responses = [
      await SELF.fetch(`${path}/versions/${mismatched.sourceVersionId}`, { headers: { cookie } }),
      await SELF.fetch(`${path}/render-requests?sourceVersionId=${mismatched.sourceVersionId}`, { headers: { cookie } }),
      await SELF.fetch(`${path}/parse`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sourceVersionId: mismatched.sourceVersionId }),
      }),
      await SELF.fetch(`${path}/page-images`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sourceVersionId: mismatched.sourceVersionId, images: [{ pageNumber: 1, fileId: crypto.randomUUID() }] }),
      }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  }
  const jobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?1').bind(projectId).first<{ n: number }>();
  expect(jobs?.n).toBe(0);
});

it('已授权成员读取来源版本时获得服务端原文件关联', async () => {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);
  const init = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/files`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: '原文件.txt', contentType: 'text/plain' }),
  });
  const file = ((await init.json()) as { data: { fileId: string; upload: { url: string } } }).data;
  const upload = await SELF.fetch(`${BASE}${file.upload.url}`, {
    method: 'PUT', headers: { cookie, 'content-type': 'text/plain' }, body: '原文件',
  });
  expect(upload.status).toBe(201);
  const create = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'file', fileId: file.fileId }),
  });
  expect(create.status).toBe(201);
  const source = ((await create.json()) as { data: { sourceId: string; sourceVersionId: string } }).data;
  const detail = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources/${source.sourceId}/versions/${source.sourceVersionId}`, { headers: { cookie } });
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as { data: { fileId: string } }).data.fileId).toBe(file.fileId);
});

it('同一解析请求键回放原任务，不重复创建异步任务', async () => {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);
  const created = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'paste', text: '仅验证任务幂等' }),
  });
  const source = ((await created.json()) as { data: { sourceId: string; sourceVersionId: string } }).data;
  const key = crypto.randomUUID();
  const jobs: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources/${source.sourceId}/parse`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ sourceVersionId: source.sourceVersionId }),
    });
    expect(response.status).toBe(202);
    jobs.push(((await response.json()) as { data: { jobId: string } }).data.jobId);
  }
  expect(jobs[1]).toBe(jobs[0]);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE project_id = ?1').bind(projectId).first<{ n: number }>();
  expect(count?.n).toBe(1);
});

it('同一页图片请求键回放已接收结果，不重复更新页面', async () => {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);
  const created = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'paste', text: '页图片幂等' }),
  });
  const source = ((await created.json()) as { data: { sourceId: string; sourceVersionId: string } }).data;
  await env.DB.batch([1, 2].map(pageNumber => env.DB.prepare('INSERT INTO source_pages (id, source_version_id, project_id, page_number, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(crypto.randomUUID(), source.sourceVersionId, projectId, pageNumber, new Date().toISOString())));
  const init = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/files`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'page.png', contentType: 'image/png' }),
  });
  const file = ((await init.json()) as { data: { fileId: string; upload: { url: string } } }).data;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), char => char.charCodeAt(0));
  const upload = await SELF.fetch(`${BASE}${file.upload.url}`, { method: 'PUT', headers: { cookie, 'content-type': 'image/png' }, body: png });
  expect(upload.status).toBe(201);
  const invalid = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources/${source.sourceId}/page-images`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sourceVersionId: source.sourceVersionId, images: [{ pageNumber: 1, fileId: file.fileId }, { pageNumber: 2, fileId: crypto.randomUUID() }] }),
  });
  expect(invalid.status).toBe(404);
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM source_pages WHERE source_version_id = ?1 AND image_status = 'uploaded'").bind(source.sourceVersionId).first<{ n: number }>();
  expect(before?.n).toBe(0);
  const key = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources/${source.sourceId}/page-images`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ sourceVersionId: source.sourceVersionId, images: [{ pageNumber: 1, fileId: file.fileId }] }),
    });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { data: unknown }).data).toEqual({ accepted: 1, remaining: 1, jobId: null });
  }
});
