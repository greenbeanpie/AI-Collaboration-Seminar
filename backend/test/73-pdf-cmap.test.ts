import { describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { cjkPdf } from './fixtures/cjk-text-layer';
import { extractPdfText, hasExtractableText, readBundledCmap } from '../src/services/pdf-text';
import { extractSourceVersionText } from '../src/services/parse';

describe('Worker PDF character maps', () => {
  it('extracts every CJK page locally without any provider or network request', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('Network forbidden in local extraction'));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await extractPdfText(cjkPdf);
      expect(result.totalPages).toBe(4);
      expect(result.text).toHaveLength(4);
      for (let page = 1; page <= 4; page++) expect(result.text[page - 1]).toContain(`中文文本层第${page}页`);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('accepts short real text, rejects only control/replacement/whitespace, and protects shared mapping bytes', () => {
    expect(hasExtractableText('第4页')).toBe(true);
    expect(hasExtractableText('A')).toBe(true);
    expect(hasExtractableText('\n\t\u0000\ufffd')).toBe(false);
    const first = readBundledCmap('UniGB-UCS2-H.bcmap');
    const expected = first[0]; first[0] = 255;
    expect(readBundledCmap('UniGB-UCS2-H.bcmap')[0]).toBe(expected);
    expect(() => readBundledCmap('__proto__')).toThrow('PDF character map unavailable');
    expect(() => readBundledCmap('../secret')).toThrow('PDF character map unavailable');
  });

  it('preserves original R2 PDF and corrects stale scan-page state on an explicit retry', async () => {
    const owner = await seedUser(); const projectId = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const init = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/files`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'synthetic-cjk.pdf' }) });
    const file = (await init.json() as { data: { fileId: string; upload: { url: string } } }).data;
    expect((await SELF.fetch(`${BASE}${file.upload.url}`, { method: 'PUT', headers: { cookie }, body: cjkPdf.slice() })).status).toBe(201);
    const created = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'file', fileId: file.fileId }) });
    const source = (await created.json() as { data: { sourceVersionId: string } }).data;
    await env.DB.prepare("INSERT INTO source_pages (id, source_version_id, project_id, page_number, text_status, updated_at) VALUES (?1, ?2, ?3, 4, 'none', ?4)").bind(crypto.randomUUID(), source.sourceVersionId, projectId, new Date().toISOString()).run();
    const result = await extractSourceVersionText(env, source.sourceVersionId);
    expect(result.needsImages).toBe(0);
    const pages = await env.DB.prepare('SELECT page_number, text_status FROM source_pages WHERE source_version_id = ?1 ORDER BY page_number').bind(source.sourceVersionId).all<{ page_number: number; text_status: string }>();
    expect(pages.results.map(p => p.text_status)).toEqual(['extracted', 'extracted', 'extracted', 'extracted']);
    const version = await env.DB.prepare('SELECT text_r2_key, page_count FROM source_versions WHERE id = ?1').bind(source.sourceVersionId).first<{ text_r2_key: string; page_count: number }>();
    expect(version?.page_count).toBe(4);
    expect(await (await env.FILES.get(version!.text_r2_key))?.text()).toContain('中文文本层第4页');
    const original = await env.DB.prepare('SELECT r2_key FROM files WHERE id = ?1').bind(file.fileId).first<{ r2_key: string }>();
    expect(new Uint8Array(await (await env.FILES.get(original!.r2_key))!.arrayBuffer())).toEqual(cjkPdf);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls').first<{ n: number }>())?.n).toBe(0);
  });
});
