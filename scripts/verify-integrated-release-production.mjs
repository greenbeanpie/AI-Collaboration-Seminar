import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Read-only production acceptance. Login/logout are the only permitted writes.
assert(process.argv.includes('--production'), 'Pass --production explicitly');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const saved = JSON.parse(readFileSync(new URL('../.local-secrets/admin-credentials.json', import.meta.url), 'utf8'));
const origin = new URL(process.env.RELEASE_URL || 'https://greenbp-team-office.hddhp.workers.dev').origin;
assert(['https://team.greenbp.dpdns.org', 'https://greenbp-team-office.hddhp.workers.dev'].includes(origin));
const output = resolve('output/integrated-release'); mkdirSync(output, { recursive: true });
const report = { origin, boundary: 'Authenticated production GET checks and browser rendering; no model probes, project changes, cancellations or diagnostic deletions', checks: [], limitations: [], browserErrors: [], blockedUiWrites: [] };
const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  try {
    await context.route('**/api/v1/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (req.method() !== 'GET' && !['/api/v1/auth/sessions', '/api/v1/auth/session'].includes(path)) {
        report.blockedUiWrites.push({ method: req.method(), path });
        return route.fulfill({ status: 409, json: { error: { code: 'INVALID_STATE', message: '本次验收仅执行读取' }, requestId: 'read-only-acceptance' } });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => report.browserErrors.push(error.message));
    const get = async tail => { const response = await context.request.get(origin + '/api/v1' + tail); assert.equal(response.status(), 200, tail); return (await response.json()).data; };
    const health = await get('/health'), deps = await get('/health/deps');
    assert.equal(health.status, 'ok'); assert.deepEqual(deps, { d1: 'ok', r2: 'ok' });
    report.checks.push({ name: 'frontend service binding, backend, D1 and R2', passed: true });
    await page.goto(origin + '/login');
    const account = saved.accounts.production;
    assert(account?.username && account?.password, 'Saved production credential missing');
    await page.getByRole('textbox', { name: '用户名或邮箱', exact: true }).fill(account.username);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    const login = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/sessions') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '登录工作区', exact: true }).click();
    assert.equal((await login).status(), 201); await page.waitForURL(origin + '/app');
    const session = await get('/auth/session');
    report.checks.push({ name: 'production password login', passed: true, role: session.user.role });
    const config = await get('/admin/ai-config');
    assert(!JSON.stringify(config).includes('apiKeyEncrypted'));
    assert(!JSON.stringify(config).includes('gatewayTokenEncrypted'));
    report.checks.push({ name: 'current AI configuration remains readable and keys masked', passed: true, version: config.version });
    if (session.user.role === 'super_admin') {
      const diagnostics = await get('/admin/ai-diagnostics');
      assert(Array.isArray(diagnostics.items)); assert.equal(diagnostics.retention.maxEntries, 1000);
      await page.goto(origin + '/app/settings/system');
      await page.getByRole('heading', { name: '系统概况', exact: true }).waitFor();
      await page.getByRole('button', { name: '查看/刷新日志', exact: true }).click();
      await page.getByText(/已保留 \d+ 条/).waitFor();
      await page.screenshot({ path: resolve(output, 'production-system.png'), fullPage: true });
      report.checks.push({ name: 'system overview diagnostic panel and GET contract', passed: true, retainedEntries: diagnostics.retention.retainedEntries });
    }
    const projects = (await get('/projects?status=all&limit=100')).items;
    let previewCandidate;
    const standardCandidate = [];
    for (const project of projects.slice(0, 12)) {
      const projectId = project.id ?? project.projectId;
      if (!projectId) continue;
      const current = await get(`/projects/${projectId}/standards/current`);
      if (current.standard && project.myRole === 'owner') standardCandidate.push(projectId);
      if (!previewCandidate) {
        const library = await get(`/projects/${projectId}/resource-library?limit=100`);
        for (const resource of library.items.filter(r => r.resourceType === 'material' && r.fileId && /\.(?:pdf|docx)$/i.test(r.title))) {
          const material = await get(`/projects/${projectId}/materials/${resource.resourceId}`);
          if (material.kind === 'task-file' && material.currentVersion?.attachments?.some(a => a.availability !== 'unavailable')) { previewCandidate = { projectId, resource, format: /\.pdf$/i.test(resource.title) ? 'pdf' : 'docx' }; break; }
        }
      }
      if (standardCandidate.length && previewCandidate) break;
    }
    if (standardCandidate.length) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${origin}/app/projects/${standardCandidate[0]}/assessment?section=standards`);
        const action = page.getByRole('button', { name: '修订生效标准', exact: true }); await action.waitFor(); assert.equal(await action.count(), 1);
        const bounds = await action.evaluate(el => ({ buttonBottom: el.getBoundingClientRect().bottom, contentTop: document.querySelector('.section-card article').getBoundingClientRect().top, inHeader: Boolean(el.closest('.section-head')) }));
        assert(bounds.inHeader && bounds.buttonBottom <= bounds.contentTop);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: resolve(output, `production-standards-${width}.png`), fullPage: true });
        report.checks.push({ name: `production standard action above content at ${width}px`, passed: true, bounds });
      }
    } else report.limitations.push('No owned project with an active standard was found in the first twelve projects; layout remains covered by the local browser fixture');
    if (previewCandidate) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${origin}/app/projects/${previewCandidate.projectId}/data?resourceType=material&resourceId=${previewCandidate.resource.resourceId}`);
        await page.getByRole('heading', { name: /文件预览 ·/ }).first().waitFor();
        if (previewCandidate.format === 'pdf') await page.locator('.file-preview canvas').first().waitFor({ state: 'visible' });
        else await page.locator('.file-preview-text').first().waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: resolve(output, `production-${previewCandidate.format}-${width}.png`), fullPage: true });
        report.checks.push({ name: `existing production ${previewCandidate.format} attachment previews at ${width}px`, passed: true });
      }
    } else report.limitations.push('No accessible existing PDF/DOCX task attachment found in the first twelve projects; upload/submission/preview remains verified against the local fixture');
    await context.request.delete(origin + '/api/v1/auth/session', { headers: { Origin: origin } });
  } finally { await context.close(); }
  assert.deepEqual(report.browserErrors, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; process.exitCode = 1; }
finally { await browser.close(); writeFileSync(resolve(output, 'production-verification.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
