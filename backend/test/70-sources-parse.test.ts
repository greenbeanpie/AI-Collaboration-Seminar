import { configureGoFixture } from './helpers/provider-config';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { makePdf, makePng } from './helpers/make-pdf';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runParseJob } from '../src/services/parse';
import { LIMITS } from '../src/core/limits';

// 种子配置默认 enabled=0（需探测后启用）；本文件测试直接启用
await configureGoFixture();

afterEach(() => {
  vi.unstubAllGlobals();
});

async function uploadFile(cookie: string, pid: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const init = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/files`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ fileName }),
  });
  expect(init.status).toBe(201);
  const initData = (await init.json() as { data: { fileId: string; upload: { url: string } } }).data;
  const put = await SELF.fetch(`${BASE}${initData.upload.url}`, {
    method: 'PUT',
    headers: { cookie },
    body: bytes,
  });
  expect(put.status).toBe(201);
  return initData.fileId;
}

async function createSource(cookie: string, pid: string, body: Record<string, unknown>): Promise<{ sourceId: string; sourceVersionId: string }> {
  const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { data: { sourceId: string; sourceVersionId: string } }).data;
}

async function startParse(cookie: string, pid: string, sourceId: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/parse`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(202);
  return (await res.json() as { data: { jobId: string } }).data.jobId;
}

/** 等待任务终态；引擎不可用（本地测试）时直接同步执行解析逻辑 */
async function ensureJobDone(cookie: string, jobId: string): Promise<{ status: string; result: unknown; error: unknown }> {
  for (let i = 0; i < 20; i++) {
    const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
    if (res.status === 200) {
      const data = (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
      if (['succeeded', 'failed', 'waiting_input'].includes(data.status)) return data;
    } else {
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Workflow 引擎不可用时的兜底：直接同步执行
  await runParseJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  const data = (await res.json() as { data: { status: string; result: unknown; error: unknown } }).data;
  return data;
}

describe('来源解析流水线', () => {
  it('粘贴文本 → 解析 → 要求草稿（引用可校验）→ 确认', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const notice = '比赛通知：参赛作品提交截止日期为 2026 年 10 月 8 日，每支队伍人数不超过 5 人，需提交申报书 PDF 与介绍视频。';
    const { sourceId, sourceVersionId } = await createSource(authCookie(owner.token), pid, { kind: 'paste', text: notice });

    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('succeeded');
    expect((done.result as { requirementSetId: string }).requirementSetId).toBeTruthy();

    // 片段已生成且可定位
    const fragRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM source_fragments WHERE source_version_id = ?1')
      .bind(sourceVersionId)
      .first<{ n: number }>();
    expect(fragRow?.n).toBeGreaterThan(0);

    // 引用校验通过（fragmentId 真实存在）
    const cite = await env.DB.prepare('SELECT citations_json FROM requirements LIMIT 1').first<{ citations_json: string }>();
    const citations = JSON.parse(cite!.citations_json) as Array<{ fragmentId: string }>;
    expect(citations[0]?.fragmentId).toMatch(/^[0-9a-f-]{36}$/);

    // 费用记录：未知费用如实标记
    const call = await env.DB.prepare("SELECT cost_status, cost_usd FROM ai_calls WHERE purpose = 'textEconomy' LIMIT 1").first<{ cost_status: string; cost_usd: number | null }>();
    expect(call?.cost_status).toBe('unknown');
    expect(call?.cost_usd).toBeNull();
  });

  it('伪造引用 → 任务失败 AI_OUTPUT_INVALID', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch({ fabricatedCitation: true }));
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const { sourceId } = await createSource(authCookie(owner.token), pid, {
      kind: 'paste',
      text: '通知正文：提交截止 2026-10-08，材料包括申报书与视频，请在平台生成申报书。',
    });
    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('failed');
    expect((done.error as { code: string }).code).toBe('AI_OUTPUT_INVALID');
  });

  it('非法 JSON 触发一次修复重试后成功', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch({ repair: true }));
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const { sourceId } = await createSource(authCookie(owner.token), pid, {
      kind: 'paste',
      text: '通知：报名截止 2026-09-30，请各队伍在平台完成报名并上传承诺书扫描件。',
    });
    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('succeeded');
    const repaired = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE status = 'repaired'").first<{ n: number }>();
    expect(repaired?.n).toBe(1);
  });

  it('文本 PDF：按页提取片段，无需页面图', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const fileId = await uploadFile(authCookie(owner.token), pid, '通知.pdf', makePdf(3));
    const { sourceId, sourceVersionId } = await createSource(authCookie(owner.token), pid, { kind: 'file', fileId });

    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('succeeded');

    const version = (await (await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/versions/${sourceVersionId}`, { headers: { cookie: authCookie(owner.token) } })).json()) as { data: { status: string; pageCount: number; pages: Array<{ textStatus: string }> } };
    expect(version.data.status).toBe('ready');
    expect(version.data.pageCount).toBe(3);
    expect(version.data.pages.every((p) => p.textStatus === 'extracted')).toBe(true);

    const pageFrags = await env.DB.prepare('SELECT DISTINCT page_number FROM source_fragments WHERE source_version_id = ?1 ORDER BY page_number')
      .bind(sourceVersionId)
      .all<{ page_number: number }>();
    expect(pageFrags.results.map((r) => r.page_number)).toEqual([1, 2, 3]);
  });

  it('扫描 PDF：等待页面图 → 上传 → 视觉 OCR → 待复核片段', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const fileId = await uploadFile(authCookie(owner.token), pid, '扫描件.pdf', makePdf(2, { text: false }));
    const { sourceId, sourceVersionId } = await createSource(authCookie(owner.token), pid, { kind: 'file', fileId });

    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('waiting_input');
    expect((done.result as { needsImages: number }).needsImages).toBe(2);

    // render-requests 给出待渲染页码
    const rr = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/render-requests`, { headers: { cookie: authCookie(owner.token) } });
    const rrBody = (await rr.json() as { data: { items: Array<{ pageNumber: number }> } }).data;
    expect(rrBody.items.map((i) => i.pageNumber)).toEqual([1, 2]);

    // 上传页面图片（两张后自动触发 OCR 任务）
    const img1 = await uploadFile(authCookie(owner.token), pid, 'page-1.png', makePng());
    const img2 = await uploadFile(authCookie(owner.token), pid, 'page-2.png', makePng());
    const up = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/page-images`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVersionId, images: [{ pageNumber: 1, fileId: img1 }, { pageNumber: 2, fileId: img2 }] }),
    });
    expect(up.status).toBe(202);
    const upBody = (await up.json() as { data: { accepted: number; remaining: number; jobId: string | null } }).data;
    expect(upBody.accepted).toBe(2);
    expect(upBody.remaining).toBe(0);
    expect(upBody.jobId).toBeTruthy();

    const ocrDone = await ensureJobDone(authCookie(owner.token), upBody.jobId!);
    expect(ocrDone.status, JSON.stringify(ocrDone.error)).toBe('succeeded');

    const ocrFrags = await env.DB.prepare("SELECT kind, needs_review FROM source_fragments f JOIN source_pages p ON p.source_version_id = f.source_version_id WHERE f.source_version_id = ?1 AND f.kind = 'ocr' LIMIT 1")
      .bind(sourceVersionId)
      .first<{ kind: string; needs_review: number }>();
    expect(ocrFrags?.kind).toBe('ocr');
    expect(ocrFrags?.needs_review).toBe(1);
  });

  it('超过旧30页建议仍可提取正文', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const fileId = await uploadFile(authCookie(owner.token), pid, '超长.pdf', makePdf(31));
    const { sourceId } = await createSource(authCookie(owner.token), pid, { kind: 'file', fileId });
    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('succeeded');
  });

  it('网页来源：白名单外拒绝；白名单内可解析', async () => {
    await env.DB.prepare(
      "INSERT INTO app_config (key, value_json, updated_at) VALUES ('web_fetch_allowlist', '[\"example.com\"]', '2026-09-29T00:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    ).run();
    const gateway = mockGatewayFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://opencode.ai/zen/go/v1/')) {
          return gateway(input, init);
        }
        if (url.startsWith('https://example.com/')) {
          return new Response(
            '<html><head><title>比赛通知</title></head><body><p>提交截止日期为 2026-10-08，团队人数不超过 5 人，请提交作品介绍 PDF。</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
        return new Response('forbidden', { status: 403 });
      }),
    );
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);

    // 白名单外
    const bad = await createSource(authCookie(owner.token), pid, { kind: 'web', url: 'https://other.org/notice' });
    const badJob = await startParse(authCookie(owner.token), pid, bad.sourceId);
    const badDone = await ensureJobDone(authCookie(owner.token), badJob);
    expect(badDone.status).toBe('failed');
    expect(((badDone.error as { details?: { host?: string } }).details?.host)).toBe('other.org');

    // 白名单内
    const good = await createSource(authCookie(owner.token), pid, { kind: 'web', url: 'https://example.com/notice' });
    const goodJob = await startParse(authCookie(owner.token), pid, good.sourceId);
    const goodDone = await ensureJobDone(authCookie(owner.token), goodJob);
    expect(goodDone.status).toBe('succeeded');
  });

  it('混合 PDF：已有文本层的页面不再等待图片（A06）', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch());
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const fileId = await uploadFile(authCookie(owner.token), pid, '混合件.pdf', makePdf(2, { scannedPages: [2] }));
    const { sourceId, sourceVersionId } = await createSource(authCookie(owner.token), pid, { kind: 'file', fileId });

    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('waiting_input');
    // 只缺扫描页，不因存在文本页而重复索要图片
    expect((done.result as { needsImages: number }).needsImages).toBe(1);

    const rr = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/render-requests`, { headers: { cookie: authCookie(owner.token) } });
    const rrBody = (await rr.json() as { data: { items: Array<{ pageNumber: number }> } }).data;
    expect(rrBody.items.map((i) => i.pageNumber)).toEqual([2]);

    const img2 = await uploadFile(authCookie(owner.token), pid, 'page-2.png', makePng());
    const up = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/page-images`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVersionId, images: [{ pageNumber: 2, fileId: img2 }] }),
    });
    expect(up.status).toBe(202);
    const upBody = (await up.json() as { data: { remaining: number; jobId: string | null } }).data;
    expect(upBody.remaining).toBe(0);
    const ocrDone = await ensureJobDone(authCookie(owner.token), upBody.jobId!);
    expect(ocrDone.status, JSON.stringify(ocrDone.error)).toBe('succeeded');
  });

  it('OCR 失败页不误报完整，且重新出现在待渲染列表（A06）', async () => {
    vi.stubGlobal('fetch', mockGatewayFetch({ visionInvalid: true }));
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const fileId = await uploadFile(authCookie(owner.token), pid, '识别失败.pdf', makePdf(1, { text: false }));
    const { sourceId, sourceVersionId } = await createSource(authCookie(owner.token), pid, { kind: 'file', fileId });

    const jobId = await startParse(authCookie(owner.token), pid, sourceId);
    const done = await ensureJobDone(authCookie(owner.token), jobId);
    expect(done.status).toBe('waiting_input');

    const img1 = await uploadFile(authCookie(owner.token), pid, 'page-1.png', makePng());
    const up = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/page-images`, {
      method: 'POST',
      headers: { cookie: authCookie(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ sourceVersionId, images: [{ pageNumber: 1, fileId: img1 }] }),
    });
    expect(up.status).toBe(202);
    const upBody = (await up.json() as { data: { jobId: string | null } }).data;

    const ocrDone = await ensureJobDone(authCookie(owner.token), upBody.jobId!);
    // 识别失败的页面不得被当作整册识别完成
    expect(ocrDone.status).toBe('failed');
    expect((ocrDone.error as { code: string }).code).toBe('AI_OUTPUT_INVALID');

    const page = await env.DB.prepare("SELECT ocr_status FROM source_pages WHERE source_version_id = ?1 AND page_number = 1")
      .bind(sourceVersionId)
      .first<{ ocr_status: string }>();
    expect(page?.ocr_status).toBe('failed');

    // 失败页可重试：仍出现在待渲染列表
    const rr = await SELF.fetch(`${BASE}/api/v1/projects/${pid}/sources/${sourceId}/render-requests`, { headers: { cookie: authCookie(owner.token) } });
    const rrBody = (await rr.json() as { data: { items: Array<{ pageNumber: number }> } }).data;
    expect(rrBody.items.map((i) => i.pageNumber)).toEqual([1]);
  });
});
