/** Actual built React app + deterministic HTTP fixtures; no provider/production calls.
 * node scripts/verify-task-ai-assistance-ui.mjs http://127.0.0.1:5179
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = process.argv[2] || 'http://127.0.0.1:5179';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const out = resolve('output/task-ai-assistance/browser'); await mkdir(out, { recursive: true });
const projectId = '11111111-1111-4111-8111-111111111111', userId = '22222222-2222-4222-8222-222222222222';
const now = '2026-10-04T08:00:00Z', base = `/app/projects/${projectId}`;
const task = { taskId: 't1', title: '整理已有研究资料', detail: '分析已保存资料并交付报告', criteria: '证据可追溯', effortHours: 4, revision: 1, assigneeId: userId, lifecycleState: 'in_progress', status: 'doing', dependsOnTaskIds: [], unfinishedDependencyIds: [], currentSubmissionId: null, citations: [], createdAt: now, updatedAt: now };
const human = { ...task, taskId: 't2', title: '现场采集样本', detail: '到现场完成采样', criteria: '真实样本记录' };
const standard = { standardsVersionId: 'std-current', projectId, title: '生效质量标准', version: 2, revision: 1, status: 'confirmed', active: true, requirements: [], mappings: [], rubric: { weights: [], notes: '' }, createdAt: now };
const browser = await chromium.launch({ headless: true, executablePath: process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const report = { fixtureOnly: true, realModelInvoked: false, checks: [], screenshots: [], errors: [] };
let activePage;
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.errors.push(error.message));
    let connected = false, dispatches = 0, planPosts = 0, stale = false, failRegeneration = false;
    const plans = new Map(), writes = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname, method = request.method();
      if (url.origin !== new URL(origin).origin) return route.abort();
      if (!p.startsWith('/api/')) return route.continue();
      if (method !== 'GET') writes.push({ p, method, body: request.postDataJSON() });
      let data = { items: [], nextCursor: null };
      if (p.endsWith('/auth/session')) data = { user: { id: userId, username: 'fixture', displayName: '测试成员', role: 'user', isAdmin: false } };
      else if (p.endsWith('/capabilities')) data = { features: { aiEnabled: true }, limits: { maxFileBytes: 20000000 }, competitionTemplate: {} };
      else if (p === `/api/v1/projects/${projectId}`) data = { projectId, name: '任务 AI 辅助验证', description: '本地固定数据', status: 'active', myRole: 'owner', revision: 1 };
      else if (p.endsWith('/members/me')) data = { userId, displayName: '测试成员', role: 'owner' };
      else if (p.endsWith('/members')) data = { items: [{ userId, displayName: '测试成员', role: 'owner' }], nextCursor: null };
      else if (p.endsWith('/goal')) data = { title: '交付研究成果', detail: '整理项目资料', revision: 1, graphRevision: 1 };
      else if (p.endsWith('/agent-eligibility')) data = { status: 'ready', taskRevision: 1, sourceHash: 'current-task-hash', eligible: p.includes('/tasks/t1/'), reason: p.includes('/tasks/t1/') ? '可通过已有资料完整执行。' : '现场采样需要真人参与。', jobId: 'eligibility-job' };
      else if (p.endsWith('/assistance-plan')) {
        const id = p.includes('/tasks/t1/') ? 't1' : 't2';
        if (method === 'POST') {
          planPosts++;
          assert.equal(request.postDataJSON().expectedRevision, 1);
          if (failRegeneration) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '模拟计划生成失败' }, requestId: 'fixture' }) }); return; }
          plans.set(id, { markdown: `## 实施步骤\n1. 核对项目资料。\n2. ${id === 't2' ? '由真人到现场采样。' : '整理分析报告。'}\n\n## 所需资料\n项目背景和生效标准。\n\n## 人工环节\n核对证据。\n\n## 验收检查\n确认成果可追溯。`, generatedAt: now, sourceHash: 'context-1', stale: false });
        }
        const saved = plans.get(id);
        data = { status: saved ? 'ready' : 'missing', taskRevision: 1, sourceHash: stale ? 'context-2' : 'context-1', plan: saved ? { ...saved, stale } : null, jobId: null, error: null };
      }
      else if (p === '/api/v1/agent-bridges/devices') data = { items: connected ? [{ deviceId: 'device-1', deviceName: '测试 DSH', paired: true, revoked: false, protocolVersion: 1, lastSeenAt: new Date().toISOString(), projects: [{ projectId, name: '任务 AI 辅助验证', workspaceLabel: 'QA 工作目录' }] }] : [] };
      else if (p.endsWith('/handoffs')) { if (method === 'POST') { dispatches++; data = { handoffId: 'handoff-1', projectId, taskId: 't1', taskRevision: 1, deviceId: 'device-1', state: 'waiting_device', reason: null, result: null, createdAt: now, updatedAt: now }; } else data = { items: dispatches ? [{ handoffId: 'handoff-1', projectId, taskId: 't1', taskRevision: 1, deviceId: 'device-1', state: 'waiting_device', reason: null, result: null, createdAt: now, updatedAt: now }] : [] }; }
      else if (p.endsWith('/tasks')) data = { items: [task, human], nextCursor: null };
      else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: true, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
      else if (p.endsWith('/collaboration/feedback/current')) data = { version: 0, feedback: '' };
      else if (p.endsWith('/standards/current')) data = { standard };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'fixture' }) });
    });
    const capture = async name => { const path = resolve(out, `${width}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
    const card = page.locator('.collab-task').filter({ has: page.getByRole('heading', { name: task.title, exact: true }) });
    const close = async () => page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    const open = async () => { await card.getByRole('button', { name: 'AI 辅助', exact: true }).click(); await page.getByRole('dialog').getByRole('heading', { name: '辅助计划', exact: true }).waitFor(); };
    await page.goto(origin + base + '/tasks'); await card.getByRole('button', { name: 'AI 辅助', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /检查 AI 适用性|连接 DSH|交给本地 Agent/ }).count(), 0);
    assert.equal(await card.locator('.notice').count(), 0); assert.equal(writes.length, 0); await capture('task-cards');
    await open(); await page.getByRole('button', { name: '生成辅助计划', exact: true }).waitFor();
    assert.equal(planPosts, 0); assert.equal(dispatches, 0); assert.equal(await page.getByRole('dialog').getByRole('tab').count(), 0);
    await page.getByRole('button', { name: '生成辅助计划', exact: true }).click(); await page.getByText('核对项目资料。', { exact: false }).waitFor(); assert.equal(planPosts, 1); await capture('saved-plan');
    await close(); await open(); await page.getByText('核对项目资料。', { exact: false }).waitFor(); assert.equal(planPosts, 1);
    failRegeneration = true; await page.getByRole('button', { name: /重新生成.*计划/ }).click(); await page.getByText('模拟计划生成失败', { exact: false }).waitFor(); assert.equal(planPosts, 2); assert.equal(await page.getByText('核对项目资料。', { exact: false }).count(), 1); await capture('failed-regeneration');
    await close(); stale = true; await open(); await page.getByText(/已变化|已过期/).first().waitFor(); assert.equal(planPosts, 2); await capture('stale-plan'); await close();
    const humanCard = page.locator('.collab-task').filter({ has: page.getByRole('heading', { name: human.title, exact: true }) }); await humanCard.getByRole('button', { name: 'AI 辅助', exact: true }).click();
    await page.getByText('现场采样需要真人参与。', { exact: false }).waitFor(); failRegeneration = false; await page.getByRole('button', { name: '生成辅助计划', exact: true }).click(); await page.getByText('由真人到现场采样。', { exact: false }).waitFor(); assert.equal(dispatches, 0); await capture('human-task-plan'); await close();
    connected = true; stale = false; await page.goto(origin + base + '/tasks'); await open(); assert.equal(dispatches, 0);
    await page.getByRole('button', { name: '交给 DSH 代实施', exact: true }).click(); await page.getByText('等待 DSH 接收', { exact: true }).waitFor(); assert.equal(dispatches, 1); await capture('dsh-explicit-dispatch');
    assert.equal(writes.filter(item => item.p.endsWith('/agent-eligibility')).length, 0);
    assert.equal(await page.getByRole('dialog').getByRole('tablist').count(), 0); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await close();
    await page.goto(origin + '/app/settings/agent-bridges'); await page.getByText(/QA 工作目录/).first().waitFor(); await capture('settings'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    report.checks.push({ width, passed: true, planPosts, dispatches, automaticEligibilityPostsFromBrowser: 0, verified: ['no card hints/check/connect', 'manual plan generation', 'saved plan reopened without model call', 'failed regeneration preserves plan', 'stale plan visible', 'human tasks can plan', 'opening dialog never dispatches', 'explicit DSH execution', 'no modal tabs', 'no horizontal overflow', 'settings directory binding'] });
    await context.close();
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.errors.push(error.stack); process.exitCode = 1; if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }); await writeFile(resolve(out, 'failure.txt'), await activePage.locator('body').innerText()); } }
finally { await browser.close(); await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, errors: report.errors, evidence: resolve(out, 'verification.json') }, null, 2));
