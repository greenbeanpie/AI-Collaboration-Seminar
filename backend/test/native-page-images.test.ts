import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

async function fixture() {
  const owner = await seedUser(); const project = await seedProject(owner.userId);
  const headers = { cookie: authCookie(owner.token), 'content-type': 'application/json' };
  const sourceResponse = await SELF.fetch(`${BASE}/api/v1/projects/${project}/sources`, { method: 'POST', headers, body: JSON.stringify({ kind: 'paste', text: '扫描页登记测试' }) });
  expect(sourceResponse.status).toBe(201);
  const source = (await sourceResponse.json() as { data: { sourceId: string; sourceVersionId: string; lifecycleVersion: number } }).data;
  await env.DB.batch([1, 2].map(page => env.DB.prepare('INSERT INTO source_pages (id, source_version_id, project_id, page_number, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(crypto.randomUUID(), source.sourceVersionId, project, page, new Date().toISOString())));
  const response = await SELF.fetch(`${BASE}/api/v1/projects/${project}/files`, { method: 'POST', headers, body: JSON.stringify({ fileName: 'page.png' }) });
  expect(response.status).toBe(201);
  const image = (await response.json() as { data: { fileId: string; upload: { url: string } } }).data;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), value => value.charCodeAt(0));
  expect((await SELF.fetch(BASE + image.upload.url, { method: 'PUT', headers: { cookie: headers.cookie }, body: png })).status).toBe(201);
  const path = `${BASE}/api/v1/projects/${project}/sources/${source.sourceId}/page-images`;
  const payload = { sourceVersionId: source.sourceVersionId, expectedLifecycleVersion: source.lifecycleVersion, analyze: false, images: [{ pageNumber: 1, fileId: image.fileId }, { pageNumber: 2, fileId: image.fileId }] };
  return { owner, project, source, headers, image, path, payload };
}
const countJobs = async (project: string) => (await env.DB.prepare('SELECT count(*) AS n FROM jobs WHERE project_id = ?1').bind(project).first<{ n: number }>())?.n;

describe('native upload-only PDF page preparation', () => {
  it('registers the last required page without scheduling OCR, preserves idempotent results and requires a key', async () => {
    const f = await fixture();
    expect((await SELF.fetch(f.path + '/prepare', { method: 'POST', headers: f.headers, body: JSON.stringify(f.payload) })).status).toBe(400);
    const headers = { ...f.headers, 'idempotency-key': crypto.randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await SELF.fetch(f.path + '/prepare', { method: 'POST', headers, body: JSON.stringify(f.payload) });
      expect(response.status).toBe(202);
      expect((await response.json() as { data: unknown }).data).toMatchObject({ accepted: 2, remaining: 0, jobId: null });
    }
    const pages = await env.DB.prepare('SELECT image_status, ocr_status FROM source_pages WHERE source_version_id = ?1 ORDER BY page_number').bind(f.source.sourceVersionId).all();
    expect(pages.results).toEqual([{ image_status: 'uploaded', ocr_status: 'none' }, { image_status: 'uploaded', ocr_status: 'none' }]);
    expect(await countJobs(f.project)).toBe(0);
  });
  it('rejects stale lifecycle, foreign source version and invalid pages before changing any pages', async () => {
    const f = await fixture();
    for (const body of [{ ...f.payload, expectedLifecycleVersion: f.source.lifecycleVersion + 1 }, { ...f.payload, sourceVersionId: crypto.randomUUID() }, { ...f.payload, images: [{ pageNumber: 0, fileId: f.image.fileId }] }, { ...f.payload, images: [{ pageNumber: 1, fileId: f.image.fileId }, { pageNumber: 99, fileId: f.image.fileId }] }]) {
      const response = await SELF.fetch(f.path + '/prepare', { method: 'POST', headers: { ...f.headers, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
      expect([400, 404]).toContain(response.status);
    }
    expect((await env.DB.prepare("SELECT count(*) AS n FROM source_pages WHERE source_version_id = ?1 AND image_status = 'uploaded'").bind(f.source.sourceVersionId).first<{ n: number }>())?.n).toBe(0);
    expect(await countJobs(f.project)).toBe(0);
  });
  it('keeps existing page-images route behavior including explicit OCR scheduling', async () => {
    const f = await fixture();
    const { expectedLifecycleVersion: _unused, ...body } = f.payload;
    const response = await SELF.fetch(f.path, { method: 'POST', headers: { ...f.headers, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
    expect(response.status).toBe(202);
    expect((await response.json() as { data: { jobId: string | null } }).data.jobId).toEqual(expect.any(String));
    expect(await countJobs(f.project)).toBe(1);
  });
  it('enforces authentication and project membership for upload-only preparation', async () => {
    const f = await fixture(); const outsider = await seedUser();
    for (const [cookie, status] of [['', 401], [authCookie(outsider.token), 403]] as const) {
      const response = await SELF.fetch(f.path + '/prepare', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(f.payload) });
      expect(response.status).toBe(status);
    }
    expect(await countJobs(f.project)).toBe(0);
  });
});
