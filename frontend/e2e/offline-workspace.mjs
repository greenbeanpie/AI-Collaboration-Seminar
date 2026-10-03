/* global navigator, process, URL, console */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const origin = process.env.WORKBENCH_URL || 'http://127.0.0.1:5175';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const output = path.resolve('../output/offline-verification'); mkdirSync(output, { recursive: true });
const profile = path.join(output, `browser-${Date.now()}`);
const userId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333', materialId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555', now = new Date().toISOString();
const permissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };
const user = { id: userId, displayName: '离线测试用户', username: 'offline-test', email: null, isAdmin: false, role: 'user' };
const project = { id: projectId, name: '离线验收项目', description: '本地浏览器验收', status: 'active', myRole: 'owner', permissions, revision: 1, deadlineDate: null, deadlinePrecision: 'unknown' };
const task = { taskId, projectId, title: '缓存任务', detail: '', criteria: '核对正文', effortHours: 1, assigneeId: null, status: 'todo', lifecycleState: 'open', revision: 1, currentSubmissionId: null, parentTaskId: null, dueDate: null, duePrecision: 'unknown', dependsOnTaskIds: [], unfinishedDependencyIds: [], createdAt: now, updatedAt: now };
let material = { materialId, title: '离线材料', kind: 'document', purpose: 'output', revision: 1, canEdit: true, currentVersionId: versionId, createdAt: now, updatedAt: now,
  currentVersion: { versionId, revision: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '联网缓存正文' }] }] }, markdown: '联网缓存正文', attachments: [], createdAt: now } };
let syncWrites = 0;
let taskWrites = 0;
const serverTasks = [task];
const errors = [];
const launch = () => chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow' });
const fixture = async context => {
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    let data = { items: [], nextCursor: null };
    if (endpoint === '/api/v1/auth/session') data = { user };
    else if (endpoint === '/api/v1/capabilities') data = { features: { aiEnabled: false }, limits: {} };
    else if (endpoint === '/api/v1/projects') data = { items: [project], nextCursor: null };
    else if (endpoint === `/api/v1/projects/${projectId}`) data = project;
    else if (endpoint.endsWith('/members/me')) data = { userId, role: 'owner', permissions };
    else if (endpoint.endsWith('/members')) data = { items: [{ userId, displayName: user.displayName, role: 'owner' }], nextCursor: null };
    else if (endpoint.endsWith('/goal')) data = { projectId, title: '离线可打开', detail: '刷新与重开后仍可工作', revision: 1, graphRevision: 1 };
    else if (endpoint.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual', revision: 1 };
    else if (endpoint.endsWith('/tasks')) data = { items: serverTasks, nextCursor: null };
    else if (endpoint.endsWith(`/tasks/${taskId}`)) data = task;
    else if (endpoint.endsWith('/materials')) data = { items: [material], nextCursor: null };
    else if (endpoint.endsWith(`/materials/${materialId}`)) data = material;
    else if (endpoint.endsWith('/versions')) data = { items: [material.currentVersion], nextCursor: null };
    else if (endpoint.endsWith('/resource-library')) data = { items: [{ resourceType: 'material', resourceId: materialId, title: material.title, purpose: 'output', currentVersionId: material.currentVersionId, revision: material.revision, createdAt: now, updatedAt: now, deletedAt: null, lifecycleVersion: 1, fileId: null, canManage: true }], nextCursor: null };
    else if (endpoint.endsWith('/collaboration/feedback')) data = { version: 0, feedback: '', history: [] };
    else if (endpoint.endsWith('/offline-sync')) {
      const input = request.postDataJSON();
      if (input.tail === 'collaboration/tasks' || input.tail === 'tasks') {
        assert.equal(input.method, 'POST'); assert.equal(input.body.title, '离线新增任务'); taskWrites++;
        data = { ...task, ...input.body, taskId: '77777777-7777-4777-8777-777777777777' }; serverTasks.push(data);
      } else {
        assert.equal(input.method, 'PUT'); assert.equal(input.tail, `materials/${materialId}`); assert.equal(input.body.expectedRevision, material.revision);
        syncWrites++;
        const saved = { ...material.currentVersion, versionId: '66666666-6666-4666-8666-666666666666', revision: material.revision + 1, doc: input.body.doc, markdown: input.body.markdown };
        material = { ...material, revision: saved.revision, currentVersionId: saved.versionId, currentVersion: saved }; data = saved;
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'offline-fixture' }) });
  });
};
let context = await launch();
try {
  await fixture(context); let page = context.pages()[0] || await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/app/projects/${projectId}`);
  await page.getByText('此项目已准备离线使用', { exact: true }).waitFor({ timeout: 20000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); await page.getByText('此项目已准备离线使用', { exact: true }).waitFor();
  await context.setOffline(true);
  await page.reload(); await page.getByText('离线工作台', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '离线验收项目' }).waitFor();
  assert.equal(await page.getByText('服务暂时无法连接', { exact: true }).count(), 0);
  await page.goto(`${origin}/app/projects/${projectId}/tasks`);
  await page.getByRole('button', { name: '缓存任务', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建子任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('离线新增任务');
  await page.getByLabel(/验收标准/).fill('联网后只创建一次');
  await page.getByRole('button', { name: '创建子任务', exact: true }).click();
  await page.getByRole('button', { name: '离线新增任务', exact: true }).waitFor();
  await page.goto(`${origin}/app/projects/${projectId}/data?resourceType=material&resourceId=${materialId}`);
  const editor = page.locator('[aria-label="材料正文编辑器"]');
  await editor.waitFor(); assert.match(await editor.innerText(), /联网缓存正文/);
  await editor.fill('断网保存的材料正文');
  await page.getByRole('button', { name: '保存到本机，联网同步', exact: true }).click();
  await page.getByText('2 项本机操作待同步', { exact: true }).waitFor();
  await page.reload(); await page.locator('[aria-label="材料正文编辑器"]').waitFor();
  assert.match(await page.locator('[aria-label="材料正文编辑器"]').innerText(), /断网保存/);
  await page.screenshot({ path: path.join(output, 'offline-material.png'), fullPage: true });
  await context.close(); context = await launch(); await fixture(context); await context.setOffline(true);
  page = context.pages()[0] || await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/app/projects/${projectId}/data?resourceType=material&resourceId=${materialId}`);
  await page.getByText('离线工作台', { exact: true }).waitFor();
  await page.locator('[aria-label="材料正文编辑器"]').waitFor();
  assert.match(await page.locator('[aria-label="材料正文编辑器"]').innerText(), /断网保存/);
  await context.setOffline(false);
  await page.getByText(/项本机操作待同步/).waitFor({ state: 'hidden', timeout: 20000 });
  assert.equal(syncWrites, 1); assert.equal(taskWrites, 1); assert.equal(material.currentVersion.markdown, '断网保存的材料正文');
  await page.screenshot({ path: path.join(output, 'reconnected-material.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ['production service-worker installation', 'offline refresh', 'offline deep-link tasks', 'offline task creation', 'cached material editor', 'offline queued save survives refresh', 'offline browser restart', 'online automatic sync exactly once'], syncWrites, taskWrites, errors };
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  const page = context.pages()[0];
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally { await context.close(); }
