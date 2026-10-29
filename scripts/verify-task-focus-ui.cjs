// Real React app, synthetic loopback API only. Start Vite before running.
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5207';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Loopback only');
const output = path.resolve(__dirname, '../output/task-hierarchy-ui');
mkdirSync(output, { recursive: true });
const now = '2026-10-29T12:00:00Z';
const base = { detail: '请核对真实资料并提交成果', criteria: '提交可核验的交付物', effortHours: 2, revision: 1, assigneeId: 'u', lifecycleState: 'in_progress', status: 'doing', currentSubmissionId: null, dependsOnTaskIds: [], manualDependsOnTaskIds: [], unfinishedDependencyIds: [], parentTaskId: null, createdAt: now, updatedAt: now };
const tasks = [
  { ...base, taskId: 'root', title: '研究报告与最终项目成果', dependsOnTaskIds: ['child'], unfinishedDependencyIds: ['child'] },
  { ...base, taskId: 'child', title: '调研分析与验证', parentTaskId: 'root', dependsOnTaskIds: ['leaf'], unfinishedDependencyIds: ['leaf'] },
  { ...base, taskId: 'leaf', title: '访谈记录与公开资料核验：支持非常长的任务标题与来源说明', parentTaskId: 'child' },
  ...Array.from({ length: 5 }, (_, i) => ({ ...base, taskId: `other${i}`, title: `独立重点任务 ${i + 1}` })),
];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH, headless: true });
  const report = { checks: [], errors: [] };
  try {
    for (const width of [320, 390, 768, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      let pinned = new Set(['leaf']);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const p = url.pathname;
        let data = { items: [], nextCursor: null };
        if (p.endsWith('/auth/session')) data = { user: { id: 'u', username: 'fixture', displayName: '测试成员', role: 'user', isAdmin: false } };
        else if (p.endsWith('/capabilities')) data = { environment: 'local', features: { aiEnabled: false }, limits: {}, competitionTemplate: {} };
        else if (p.endsWith('/resource-usage')) data = { ai: { enabled: false, user: { used: 0, limit: 20, remaining: 20 }, project: null, day: '2026-10-29', platformDailyLimit: 100, globalConcurrencyLimit: 3 }, storage: { inventoryReady: true, user: { used: 0, limit: 100000000, reserved: 0 }, project: null } };
        else if (p === '/api/v1/projects/p') data = { projectId: 'p', name: '任务关系与个人重点', description: '模拟项目', myRole: 'owner', status: 'active', revision: 1 };
        else if (p.endsWith('/goal')) data = { title: '完成研究报告', detail: '', revision: 1, graphRevision: 1 };
        else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
        else if (p.endsWith('/tasks/focus')) data = { items: tasks.map(task => ({ ...task, pinned: pinned.has(task.taskId), focusReasons: [pinned.has(task.taskId) ? '已置顶' : '即将到期'] })), waitingReview: [], reviewRequired: [] };
        else if (p.endsWith('/pin')) { const id = p.split('/').at(-2); const value = route.request().postDataJSON().pinned; if (value) pinned.add(id); else pinned.delete(id); data = { taskId: id, pinned: value }; }
        else if (p.endsWith('/tasks/graph')) data = { items: tasks, graphRevision: 1, canRegenerate: false, totals: { total: tasks.length, done: 0 } };
        else if (p.endsWith('/tasks')) data = url.searchParams.has('cursor') ? { items: tasks.slice(2), nextCursor: null } : { items: tasks.slice(0, 2), nextCursor: 'more' }; // graph must include unloaded matches
        else if (tasks.some(task => p.endsWith(`/tasks/${task.taskId}`))) data = tasks.find(task => p.endsWith(`/tasks/${task.taskId}`));
        else if (p.endsWith('/members/me')) data = { userId: 'u', displayName: '测试成员', role: 'owner' };
        else if (p.endsWith('/members')) data = { items: [{ userId: 'u', displayName: '测试成员', role: 'owner' }], nextCursor: null };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, requestId: 'task-hierarchy-fixture' }) });
      });
      await page.goto(`${origin}/app/projects/p/tasks`);
      await page.getByRole('heading', { name: '我现在需要处理' }).waitFor({ timeout: 15000 }).catch(async error => { console.error(await page.locator('body').innerText()); await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); throw error; });
      await page.locator('.collab-tree .collab-task').last().waitFor();
      assert.equal(await page.locator('.task-focus-item').count(), 5);
      await page.getByRole('button', { name: '查看全部 8 项' }).click();
      assert.equal(await page.locator('.task-focus-item').count(), 8);
      await page.getByRole('button', { name: '收起重点任务' }).click();
      assert.equal(await page.locator('.collab-tree .collab-task').count(), 8);
      await page.getByRole('button', { name: '折叠全部' }).click();
      assert.equal(await page.locator('.collab-tree .collab-task').count(), 6);
      await page.getByLabel('按名称筛选任务', { exact: true }).fill('访谈');
      assert.equal(await page.locator('.collab-tree .collab-task').count(), 3);
      assert.equal(await page.locator('.collab-tree .task-context').count(), 2);
      await page.getByLabel('按名称筛选任务', { exact: true }).fill('');
      await page.getByRole('button', { name: '展开全部' }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(overflow, false, `overflow at ${width}`);
      const pinItem = page.locator('.task-focus-item').first();
      await pinItem.getByRole('button', { name: '为我置顶' }).click();
      await pinItem.getByRole('button', { name: '取消置顶' }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, `tasks-${width}.png`), fullPage: true });
      await page.locator('.collab-tree .collab-task').first().getByRole('button', { name: '调研分析与验证', exact: true }).click();
      await page.getByRole('dialog', { name: '调研分析与验证', exact: true }).waitFor();
      assert.ok(await page.getByRole('dialog').getByLabel('父任务路径').count());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
      report.checks.push({ width, focusLimit: true, hierarchy: true, unloadedMatch: true, relationNavigation: true, pin: true, noOverflow: true });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
  } finally { writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; });
