// Real React UI + Chromium, intercepted synthetic APIs only; no production/model calls.
// UI_ORIGIN=http://127.0.0.1:5179 node scripts/verify-admin-ai-retries-ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bundledPlaywright = '/Users/hddhp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || (fs.existsSync(bundledPlaywright) ? bundledPlaywright : 'playwright'));
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5179';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use a loopback frontend origin');
const output = path.resolve(process.env.UI_EVIDENCE_DIR || 'output/admin-ai-retries-ui');
fs.mkdirSync(output, { recursive: true });
const report = { source: 'Real React app and Chromium; all APIs intercepted, no production or paid requests', checks: [], errors: [] };
const user = { id: 'fixture-admin', displayName: '本地管理员', username: 'fixture_admin', email: null, role: 'super_admin', isAdmin: true };
const batch = { batchId: '00000000-0000-4000-a000-000000000001', status: 'completed', total: 4, pending: 0, queued: 3, skipped: 1, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', skipReasons: [{ reason: '请求已恢复', count: 1 }] };
async function fixture(context, role) {
  const state = { posts: 0, deny: false, currentUser: { ...user, role }, release: null, latestBatch: null, sessionReads: 0 };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let data = { items: [], nextCursor: null };
    if (url.pathname === '/api/v1/auth/session') { state.sessionReads++; data = { user: state.currentUser }; }
    else if (url.pathname === '/api/v1/admin/ai-retries') {
      if (state.deny) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '权限已移除', retryable: false }, requestId: 'denied-fixture' }) });
      if (request.method() === 'POST') {
        assert.equal(state.currentUser.role, 'super_admin'); state.posts++;
        assert.match(request.postDataJSON().idempotencyKey, /^[a-f0-9-]{36}$/);
        await new Promise(resolve => { state.release = resolve; });
        state.latestBatch = batch; data = { batch, replayed: false };
      } else data = { failedCount: 4, activeBatch: null, latestBatch: state.latestBatch };
    } else if (request.method() !== 'GET') throw new Error(`Unexpected mutation ${request.method()} ${url.pathname}`);
    await route.fulfill({ status: request.method() === 'POST' ? 202 : 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'admin-retry-ui-fixture' }) });
  });
  return state;
}
async function verify() {
  const browser = await chromium.launch({ headless: true, ...(process.env.UI_CHROMIUM_PATH ? { executablePath: process.env.UI_CHROMIUM_PATH } : {}) });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      const state = await fixture(context, 'super_admin'); const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(origin + '/app/settings/accounts');
      const button = page.getByRole('button', { name: '将所有失败请求排队重试', exact: true });
      await button.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '将所有失败请求排队重试' && !b.disabled));
      await page.screenshot({ path: path.join(output, `super-admin-${width}.png`), fullPage: true });
      await button.click(); const pending = page.getByRole('button', { name: '正在提交重试批次……', exact: true }); await pending.waitFor();
      assert(await pending.isDisabled()); await pending.evaluate(el => el.click()); assert.equal(state.posts, 1);
      await page.screenshot({ path: path.join(output, `pending-${width}.png`), fullPage: true });
      state.release(); await page.getByText('已排队 3 / 4 · 待处理 0 · 已跳过 1', { exact: true }).waitFor();
      await page.getByText('请求已恢复：1', { exact: true }).waitFor(); assert.equal(state.posts, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
      await page.screenshot({ path: path.join(output, `completed-${width}.png`), fullPage: true });
      state.deny = true; state.currentUser = { ...user, role: 'user', isAdmin: false }; const sessionBefore = state.sessionReads;
      await page.getByRole('button', { name: '刷新重试状态', exact: true }).click();
      await button.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: '失败 AI 请求重试' }).waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.body.textContent.includes('fixture_admin · 超级管理员')); 
      assert.equal(await button.count(), 0); assert.equal(await page.getByRole('heading', { name: '失败 AI 请求重试' }).count(), 0); assert(state.sessionReads > sessionBefore);
      await page.screenshot({ path: path.join(output, `revoked-${width}.png`), fullPage: true });
      report.checks.push({ width, superAdminCard: true, enqueueOnce: true, duplicateDisabled: true, skipReason: true, permissionsRevoked: true, noOverflow: true });
      await context.close();
      const ordinary = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      const ordinaryState = await fixture(ordinary, 'admin'); const ordinaryPage = await ordinary.newPage(); ordinaryPage.on('pageerror', error => report.errors.push(error.message));
      await ordinaryPage.goto(origin + '/app/settings/accounts'); await ordinaryPage.getByText('只有超级管理员可以将所有失败请求排队重试。', { exact: true }).waitFor();
      assert.equal(await ordinaryPage.getByRole('button', { name: '将所有失败请求排队重试', exact: true }).count(), 0); assert.equal(ordinaryState.posts, 0);
      await ordinaryPage.screenshot({ path: path.join(output, `ordinary-admin-${width}.png`), fullPage: true });
      report.checks.push({ width, ordinaryAdminReadOnly: true }); await ordinary.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(report.errors, []); report.result = 'PASS'; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ result: 'PASS', checks: report.checks.length, output }));
}
verify().catch(error => { report.result = 'FAIL'; report.errors.push(error.message); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.error(error); process.exitCode = 1; });
