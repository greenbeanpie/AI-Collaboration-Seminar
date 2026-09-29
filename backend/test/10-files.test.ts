import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { sha256Hex } from '../src/core/db';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 minimal magic-check body');

async function initFile(token: string, projectId: string, fileName = '通知.pdf') {
  return SELF.fetch(`${BASE}/api/v1/projects/${projectId}/files`, {
    method: 'POST',
    headers: { cookie: authCookie(token), 'content-type': 'application/json' },
    body: JSON.stringify({ fileName, contentType: 'application/pdf' }),
  });
}

describe('文件上传与下载', () => {
  it('完整流程：初始化 → 上传（校验通过） → 下载一致', async () => {
    const owner = await seedUser('owner@example.com');
    const pid = await seedProject(owner.userId);

    const init = await initFile(owner.token, pid);
    expect(init.status).toBe(201);
    const initData = ((await init.json()) as { data: { fileId: string; upload: { url: string } } }).data;

    const put = await SELF.fetch(`${BASE}${initData.upload.url}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/pdf' },
      body: PDF_BYTES,
    });
    expect(put.status).toBe(201);
    const putData = (await put.json()) as { data: { sizeBytes: number; sha256: string; mimeDetected: string } };
    expect(putData.data.sizeBytes).toBe(PDF_BYTES.byteLength);
    expect(putData.data.mimeDetected).toBe('application/pdf');
    expect(putData.data.sha256).toBe(await sha256Hex(PDF_BYTES));

    const get = await SELF.fetch(`${BASE}${initData.upload.url}`, {
      headers: { cookie: authCookie(owner.token) },
    });
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it('文件头与扩展名不符 → 415 并隔离暂存，下载不可用', async () => {
    const owner = await seedUser('owner@example.com');
    const pid = await seedProject(owner.userId);
    const init = await initFile(owner.token, pid, '假文件.pdf');
    const initData = ((await init.json()) as { data: { fileId: string; upload: { url: string } } }).data;

    const put = await SELF.fetch(`${BASE}${initData.upload.url}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token) },
      body: new TextEncoder().encode('这不是 PDF'),
    });
    expect(put.status).toBe(415);
    const body = (await put.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const row = await env.DB.prepare('SELECT status FROM files WHERE id = ?1').bind(initData.fileId).first<{ status: string }>();
    expect(row?.status).toBe('quarantined');

    const get = await SELF.fetch(`${BASE}${initData.upload.url}`, { headers: { cookie: authCookie(owner.token) } });
    expect(get.status).toBe(404);
  });

  it('超过 10MiB → 413 且不落 R2', async () => {
    const owner = await seedUser('owner@example.com');
    const pid = await seedProject(owner.userId);
    const init = await initFile(owner.token, pid);
    const initData = ((await init.json()) as { data: { fileId: string; upload: { url: string } } }).data;

    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.fill(0x41);
    const put = await SELF.fetch(`${BASE}${initData.upload.url}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token) },
      body: oversized,
    });
    expect(put.status).toBe(413);
    const row = await env.DB.prepare('SELECT status, size_bytes FROM files WHERE id = ?1').bind(initData.fileId).first<{ status: string; size_bytes: number | null }>();
    expect(row?.status).toBe('pending');
    expect(row?.size_bytes).toBeNull();
  });

  it('重复上传 → 409 INVALID_STATE', async () => {
    const owner = await seedUser('owner@example.com');
    const pid = await seedProject(owner.userId);
    const init = await initFile(owner.token, pid);
    const initData = ((await init.json()) as { data: { fileId: string; upload: { url: string } } }).data;
    const putOnce = await SELF.fetch(`${BASE}${initData.upload.url}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token) },
      body: PDF_BYTES,
    });
    expect(putOnce.status).toBe(201);
    const putAgain = await SELF.fetch(`${BASE}${initData.upload.url}`, {
      method: 'PUT',
      headers: { cookie: authCookie(owner.token) },
      body: PDF_BYTES,
    });
    expect(putAgain.status).toBe(409);
    expect(((await putAgain.json()) as { error: { code: string } }).error.code).toBe('INVALID_STATE');
  });

  it('未登录 401 / 非成员 403 / 项目不存在 404', async () => {
    const owner = await seedUser('owner@example.com');
    const outsider = await seedUser('outsider@example.com');
    const pid = await seedProject(owner.userId);

    const anon = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'a.pdf' }),
    });
    expect(anon.status).toBe(401);

    const foreigner = await initFile(outsider.token, pid);
    expect(foreigner.status).toBe(403);

    const missing = await initFile(owner.token, '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('不支持的扩展名 → 400 VALIDATION_FAILED', async () => {
    const owner = await seedUser('owner@example.com');
    const pid = await seedProject(owner.userId);
    const init = await initFile(owner.token, pid, '病毒.exe');
    expect(init.status).toBe(400);
    expect(((await init.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });
});
