// Loopback-only browser fixture. No real accounts, originals, credentials, or model calls.
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5198';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Loopback only');
const now = '2026-10-02T00:00:00Z';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = []; const mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    let file = { fileId: 'pending', name: '尚未上传完成的资料.pdf', status: 'pending', sizeBytes: null, createdAt: now, deletedAt: null, lifecycleVersion: 1, canDelete: true, sourceIds: [] };
    const readonlyFile = { ...file, fileId: 'readonly', name: '其他成员上传的资料.pdf', status: 'available', sizeBytes: 20_000, canDelete: false };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname; const method = route.request().method();
      const body = method === 'GET' ? null : route.request().postDataJSON();
      let data = { items: [], nextCursor: null };
      if (method !== 'GET') mutations.push({ path, method, body });
      if (path === '/api/v1/auth/session') data = { user: { id: 'member', username: 'fixture', displayName: '本地测试成员', email: null, role: 'user', isAdmin: false } };
      else if (path === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: true, webFetch: false }, limits: { maxFileBytes: 20_000_000, maxPdfPages: 50, pageImageMaxEdge: 1600, pageImageMaxBytes: 1_000_000, listDefaultPageSize: 20, listMaxPageSize: 100 }, competitionTemplate: {} };
      else if (path === '/api/v1/projects/p') data = { projectId: 'p', name: '资料回收功能本地验证', description: '可恢复移除与手动恢复', myRole: 'owner', status: 'active', revision: 1, deadlineDate: null, deadlinePrecision: 'unknown', updatedAt: now };
      else if (path.endsWith('/files/pending') && method === 'DELETE') {
        assert.equal(body.expectedLifecycleVersion, file.lifecycleVersion);
        file = { ...file, deletedAt: now, lifecycleVersion: file.lifecycleVersion + 1 };
        data = { fileId: file.fileId, deletedAt: file.deletedAt, lifecycleVersion: file.lifecycleVersion, affectedSourceIds: [] };
      } else if (path.endsWith('/files/pending/restore') && method === 'POST') {
        assert.equal(body.expectedLifecycleVersion, file.lifecycleVersion);
        file = { ...file, deletedAt: null, lifecycleVersion: file.lifecycleVersion + 1 };
        data = { fileId: file.fileId, deletedAt: null, lifecycleVersion: file.lifecycleVersion, affectedSourceIds: [] };
      } else if (path.endsWith('/files')) data = { items: [file, readonlyFile].filter(item => Boolean(item.deletedAt) === (url.searchParams.get('deleted') === 'true')), nextCursor: null };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, requestId: 'recycle-ui-fixture' }) });
    });
    await page.goto(origin + '/app/projects/p/sources');
    await page.getByRole('button', { name: '移入回收站：尚未上传完成的资料.pdf' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '移入回收站：其他成员上传的资料.pdf' }).count(), 0);
    await page.screenshot({ path: '/tmp/project2-recycle-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '移入回收站：尚未上传完成的资料.pdf' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor(); assert.match(await dialog.innerText(), /费用无法撤回/);
    await page.screenshot({ path: '/tmp/project2-recycle-dialog.png' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(mutations.length, 0);
    await page.getByRole('button', { name: '移入回收站：尚未上传完成的资料.pdf' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认移入回收站' }).click();
    await page.getByText('资料已移入回收站，原文件和历史已保留。', { exact: true }).waitFor();
    assert.equal(mutations.length, 1);
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    await page.getByRole('button', { name: '恢复文件：尚未上传完成的资料.pdf' }).waitFor();
    await page.screenshot({ path: '/tmp/project2-recycle-trash-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No mobile overflow');
    await page.screenshot({ path: '/tmp/project2-recycle-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '恢复文件：尚未上传完成的资料.pdf' }).click();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.getByRole('dialog').innerText(), /恢复不会自动启动/);
    await page.screenshot({ path: '/tmp/project2-recycle-restore-mobile.png' });
    await page.getByRole('dialog').getByRole('button', { name: '确认恢复' }).click();
    await page.getByText('资料已恢复。未自动启动任何 AI 处理，请按需手动开始。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '文件库', exact: true }).click();
    await page.getByRole('button', { name: '移入回收站：尚未上传完成的资料.pdf' }).waitFor();
    assert.equal(file.fileId, 'pending'); assert.equal(file.status, 'pending');
    assert.deepEqual(mutations.map(item => item.method), ['DELETE', 'POST']);
    assert.equal(mutations.filter(item => item.method === 'POST' && !item.path.endsWith('/restore')).length, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: pending upload visibility, permission-hidden removal, in-page cancel, recoverable delete/restore, no AI on restore, desktop/mobile no overflow, no browser errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
