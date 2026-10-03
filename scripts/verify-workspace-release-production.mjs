import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Explicit production READ verification. Only login/logout write requests are intentional;
// never submit feedback, invitations, task plans, model probes or score changes here.
assert(process.argv.includes('--production'), 'Pass --production explicitly');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const saved = JSON.parse(readFileSync(new URL('../.local-secrets/admin-credentials.json', import.meta.url), 'utf8'));
const origin = new URL(process.env.RELEASE_URL || 'https://team.greenbp.dpdns.org').origin;
assert(['https://team.greenbp.dpdns.org', 'https://greenbp-team-office.hddhp.workers.dev'].includes(origin));
const output = resolve('output/cf-release-20261003'); mkdirSync(output, { recursive: true });
const report = { origin, browser: 'Google Chrome', checks: [], limitations: [], errors: [], blockedUiWrites: [], offlineTested: false };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
async function check(name, action) { await action(); report.checks.push({ name, passed: true }); }
try {
  for (const [role, account] of [['administrator', saved.accounts.production], ['ordinary', saved.acceptanceAccounts.at(-1)]]) {
    assert(account?.username && account?.password, 'Private credentials missing');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
    try {
      await context.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== 'GET' && path !== '/api/v1/auth/sessions' && path !== '/api/v1/auth/session') {
          report.blockedUiWrites.push({ role, path });
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_STATE', message: '本次线上验收仅检查读取，不执行写入或模型调用', retryable: false }, requestId: 'release-read-verification' }) });
        } else await route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => report.errors.push({ role, message: error.message }));
      await page.goto(origin + '/login');
      await page.getByLabel('用户名或邮箱', { exact: true }).fill(account.username);
      await page.getByLabel('密码', { exact: true }).fill(account.password);
      const login = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/sessions') && response.request().method() === 'POST');
      await page.getByRole('button', { name: '登录工作区', exact: true }).click();
      const response = await login;
      if (response.status() === 401) {
        report.limitations.push(`${role}: saved credentials rejected (401); no credential reset attempted`);
        continue;
      }
      assert.equal(response.status(), 201);
      await page.waitForURL(origin + '/app');
      report.checks.push({ name: `${role} Chrome UI login`, passed: true });
      const api = async path => {
        const response = await context.request.get(origin + '/api/v1' + path);
        assert.equal(response.status(), 200, path + ' status');
        return (await response.json()).data;
      };
      const projects = await api('/projects?status=all&limit=100');
      const project = projects.items.find(project => project.status === 'active' && project.myRole === 'member') ?? projects.items.find(project => project.status === 'active') ?? projects.items[0];
      assert(project, 'Existing account has no project to verify');
      const base = `/app/projects/${project.id}`, apiBase = `/projects/${project.id}`;
      await check(`${role} new backend feedback/history contracts`, async () => {
        const feedback = await api(apiBase + '/collaboration/feedback/current');
        assert.equal(typeof feedback.version, 'number'); assert.equal(typeof feedback.feedback, 'string');
        assert(Array.isArray((await api(apiBase + '/collaboration/feedback/history')).items));
        assert(Array.isArray((await api(apiBase + '/invitation-requests')).items));
        assert.equal(typeof (await api(apiBase)).permissions.scoreCorrect, 'boolean');
      });
      await check(`${role} overview layout`, async () => {
        await page.goto(origin + base); await page.getByText('项目主目标', { exact: true }).waitFor();
        await page.locator('.project-overview-columns').waitFor();
        assert.equal(await page.getByText('团队成员', { exact: true }).count(), 0);
        assert.equal(await page.getByText('材料版本', { exact: true }).count(), 0);
        await page.screenshot({ path: resolve(output, role + '-overview.png'), fullPage: true });
      });
      await check(`${role} permanent feedback and header history`, async () => {
        await page.goto(origin + base + '/tasks');
        await page.getByRole('button', { name: 'AI 拆解、调整与分工', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'AI 拆解、调整与分工' });
        await dialog.getByLabel('持续项目反馈', { exact: true }).waitFor();
        assert.equal(await page.getByText('负责人反馈与重新判断', { exact: true }).count(), 0);
        await dialog.locator('.modal-head').getByRole('button', { name: '历史记录', exact: true }).waitFor();
        await dialog.getByRole('button', { name: '选择优先参考文件', exact: true }).waitFor();
        const tasks = await api(apiBase + '/tasks?limit=100');
        if (tasks.items.some(task => task.startedAt || task.assigneeId || task.status !== 'todo')) assert(await dialog.getByRole('button', { name: '重新生成整套任务建议' }).isDisabled());
        await page.screenshot({ path: resolve(output, role + '-feedback.png'), fullPage: true });
      });
      await check(`${role} invitation controls`, async () => {
        await page.goto(origin + base + '/team');
        if (project.myRole === 'member' && !project.canGrantPermissions) {
          await page.getByRole('button', { name: '报请管理员批准', exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: '创建邀请码', exact: true }).count(), 0);
        }
        await page.screenshot({ path: resolve(output, role + '-team.png'), fullPage: true });
      });
      await check(`${role} mobile overview`, async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(origin + base); await page.locator('.project-overview-columns').waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
        await page.screenshot({ path: resolve(output, role + '-mobile.png'), fullPage: true });
      });
      await context.request.delete(origin + '/api/v1/auth/session', { headers: { Origin: origin } });
    } finally { await context.close(); }
  }
  assert(report.checks.some(check => check.name.includes('Chrome UI login')), 'No saved account could sign in');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; process.exitCode = 1; }
finally { await browser.close(); writeFileSync(resolve(output, 'chrome-results.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
