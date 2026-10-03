// Isolated loopback fixtures; never authenticates to production or invokes AI.
// Run --serve, then run this script without arguments in a second terminal.
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:5203';
const apiOrigin = 'http://127.0.0.1:8803';
const now = new Date().toISOString();
const today = now.slice(0, 10);
const task = (taskId, changes = {}) => ({ taskId, title: taskId, detail: '', criteria: '完成固定测试交付', effortHours: 1, status: 'doing', lifecycleState: 'in_progress', assigneeId: 'member', revision: 1, dueDate: today, duePrecision: 'date', dependsOnTaskIds: [], unfinishedDependencyIds: [], parentTaskId: null, currentSubmissionId: null, citations: [], createdAt: now, updatedAt: now, ...changes });
const projects = [
  { id: 'ready', name: '已分配且可推进的项目' },
  { id: 'waiting', name: '仍有未完成任务的等待项目' },
  { id: 'done', name: '全部完成项目' },
  { id: 'empty', name: '暂无任务项目' },
  { id: 'archived', name: '归档项目', status: 'archived' },
].map(p => ({ status: 'active', myRole: 'owner', description: '只读界面测试数据', deadlineDate: today, deadlinePrecision: 'date', revision: 1, ...p }));
const tasks = {
  ready: [task('前置已完成', { status: 'done', lifecycleState: 'accepted' }), task('可以立即处理'), task('可处理的后续任务', { assigneeId: 'other-member', dependsOnTaskIds: ['前置已完成'] }), task('可以立即处理'), task('未分配任务', { assigneeId: null, status: 'todo', lifecycleState: 'open' }), task('等待前置任务', { dependsOnTaskIds: ['未分配任务'], unfinishedDependencyIds: ['未分配任务'] }), task('等待验收任务', { lifecycleState: 'submitted' }), task('受阻任务', { status: 'blocked' }), task('已离开成员任务', { assigneeId: 'former-member' })],
  waiting: [task('尚未认领任务', { assigneeId: null, status: 'todo', lifecycleState: 'open' })],
  done: [task('已完成任务', { status: 'done', lifecycleState: 'accepted' })],
  empty: [], archived: [task('归档任务')],
};
function serve() {
  const server = createServer((req, res) => {
    const p = new URL(req.url, apiOrigin).pathname;
    if (req.method !== 'GET') { res.writeHead(405); res.end('Read-only fixture'); return; }
    let data = { items: [], nextCursor: null };
    const projectId = p.match(/^\/api\/v1\/projects\/([^/]+)/)?.[1];
    if (p === '/api/v1/auth/session') data = { user: { id: 'member', username: 'fixture', displayName: '测试成员', email: null, role: 'user', isAdmin: false } };
    else if (p === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false, webFetch: false, emailMode: 'disabled' }, limits: { maxFileBytes: 10485760, maxPdfPages: 30, pageImageMaxEdge: 2000, pageImageMaxBytes: 2097152, concurrentAiTasksPerProject: 2, listDefaultPageSize: 20, listMaxPageSize: 100 }, competitionTemplate: { teamSizeLimit: null } };
    else if (p === '/api/v1/projects') data = { items: projects, nextCursor: null };
    else if (projectId && p.endsWith('/tasks')) data = { items: tasks[projectId] || [], nextCursor: null };
    else if (projectId && p.endsWith('/members')) data = { items: [{ userId: 'member', displayName: '测试成员', role: 'owner' }, { userId: 'other-member', displayName: '其他当前成员', role: 'member' }] };
    else if (projectId && p.endsWith('/members/me')) data = { userId: 'member', displayName: '测试成员', role: 'owner' };
    else if (projectId && p.endsWith('/goal')) data = { title: '固定测试目标', detail: '', revision: 1, graphRevision: 1 };
    else if (projectId && p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual', revision: 1 };
    else if (projectId && p === `/api/v1/projects/${projectId}`) data = { ...projects.find(item => item.id === projectId), projectId, updatedAt: now };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data, requestId: 'dashboard-actionable-fixture' }));
  });
  server.listen(8803, '127.0.0.1');
  const vite = spawn(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5203'], { cwd: path.join(root, 'frontend'), env: { ...process.env, AI_OFFICE_API_TARGET: apiOrigin }, stdio: 'inherit' });
  const stop = () => { vite.kill(); server.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
async function verify() {
  const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
  const output = path.join(root, 'output/dashboard-actionable');
  mkdirSync(output, { recursive: true });
  const report = { source: 'Real React app, read-only loopback fixtures', checks: [], errors: [] };
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH, headless: true });
  try {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      await context.addInitScript(value => localStorage.setItem('ai-office-theme', value), theme);
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(origin + '/app');
      const attention = page.getByRole('complementary', { name: '待响应事项' });
      await attention.getByText('2 项可完成', { exact: true }).first().waitFor();
      assert.equal(await attention.locator('.dashboard-attention-project').count(), 2);
      assert.equal(await attention.locator('.dashboard-project-tasks li').count(), 2);
      assert.equal(await page.locator('.dashboard-deadline .dashboard-metric-value').textContent(), '2项');
      assert.equal(await page.getByText('今日截止 2 项', { exact: true }).count(), 1);
      assert.equal(await attention.getByText('暂无可完成任务', { exact: true }).count(), 1);
      for (const hidden of ['未分配任务', '等待前置任务', '等待验收任务', '受阻任务', '已离开成员任务', '全部完成项目', '暂无任务项目', '归档项目']) assert.equal(await attention.getByText(hidden, { exact: true }).count(), 0, hidden);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal page overflow');
      await page.screenshot({ path: path.join(output, `dashboard-${width}-${theme}.png`), fullPage: true });
      const projectLink = attention.locator('.dashboard-attention-project-link').first();
      assert.equal(await projectLink.getAttribute('href'), '/app/projects/ready');
      await projectLink.click(); await page.waitForURL('**/app/projects/ready');
      await page.goBack(); await attention.waitFor();
      await attention.getByRole('link', { name: /可以立即处理/ }).click();
      await page.waitForURL(url => url.pathname === '/app/projects/ready/tasks' && url.searchParams.get('task') === '可以立即处理');
      await page.goBack(); await attention.waitFor();
      await page.getByRole('button', { name: '列表', exact: true }).click();
      assert.equal(await attention.locator('.dashboard-attention-project').count(), 2);
      report.checks.push({ width, theme, grouping: true, counts: 2, zeroActionableEntry: true, projectAndTaskNavigation: true, noHorizontalOverflow: true });
      await context.close();
    }
    assert.deepEqual(report.errors, []);
  } finally { await browser.close(); writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv.includes('--serve')) serve();
else verify().catch(error => { console.error(error); process.exitCode = 1; });
