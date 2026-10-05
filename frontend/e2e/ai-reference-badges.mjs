/* global process, URL, console, indexedDB, document, innerWidth, getComputedStyle */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const origin = process.env.WORKBENCH_URL || 'http://127.0.0.1:5175';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const output = path.resolve('../output/ai-reference-verification'); mkdirSync(output, { recursive: true });
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
const prepared = page => page.waitForFunction(async ({ userId, projectId }) => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('buwei-offline-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
  const ready = await new Promise(resolve => { const request = db.transaction('snapshots').objectStore('snapshots').get(`${userId}:/api/v1/projects/${projectId}/offline-ready`); request.onsuccess = () => resolve(Boolean(request.result)); });
  db.close(); return ready;
}, { userId, projectId });
const launch = () => chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow' });
const fixture = async context => {
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    let data = { items: [], nextCursor: null };
    if (endpoint === '/api/v1/auth/session') data = { user };
    else if (endpoint === '/api/v1/capabilities') data = { features: { aiEnabled: false }, limits: { listMaxPageSize:100 }, competitionTemplate: { teamSizeLimit:100 } };
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

const context = await launch();
const observations = [];
const badges = page => page.locator('[data-ai-reference-badge]:visible');
const mark = async (page, label) => {
  const field = page.locator('label.field').filter({ has: page.getByText(label, { exact: true }) });
  await field.locator('input, textarea, select').first().waitFor();
  assert.equal(await field.locator('[data-ai-reference-badge]').count(), 1, label);
};
try {
  await fixture(context);
  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app/projects/' + projectId + '/tasks');
  await page.getByRole('button', { name: '缓存任务', exact: true }).waitFor();
  await prepared(page);
  assert.ok(await badges(page).count() >= 3);
  const style = await badges(page).first().evaluate(el => { const s = getComputedStyle(el); return { color:s.color, background:s.backgroundColor, radius:s.borderRadius }; });
  assert.equal(style.color, 'rgb(35, 88, 165)'); assert.equal(style.background, 'rgb(229, 240, 255)'); assert.equal(style.radius, '999px');
  assert.equal(await page.getByLabel('筛选', { exact:true }).locator('xpath=ancestor::label').locator('[data-ai-reference-badge]').count(), 0);
  await page.getByRole('button', { name:'新建任务', exact:true }).click();
  for (const label of ['任务名称','任务说明','任务执行人（选填）','预计投入（小时）','截止日期（选填）']) await mark(page,label);
  await page.screenshot({ path:path.join(output,'tasks-light.png'),fullPage:true });
  await page.setViewportSize({ width:390,height:844 });
  assert.ok(await badges(page).evaluateAll(elements=>elements.every(el=>{const r=el.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth;})));
  await page.screenshot({path:path.join(output,'task-form-mobile.png'),fullPage:true});
  await page.getByRole('button', { name:'取消', exact:true }).click();
  await page.setViewportSize({ width:390,height:844 });
  assert.ok(await badges(page).first().evaluate(el => { const r=el.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; }));
  await page.screenshot({ path:path.join(output,'tasks-mobile.png'),fullPage:true });
  await page.setViewportSize({ width:1440,height:1000 });
  await page.goto(origin + '/app/projects/' + projectId + '/settings');
  for (const label of ['项目名称','项目说明','主目标','目标说明（可选）']) await mark(page,label);
  observations.push('project/task inputs marked; pure filter unmarked');
  await page.goto(origin + '/app/projects/' + projectId + '/data?resourceType=material&resourceId=' + materialId);
  await page.locator('[aria-label="材料正文编辑器"]').waitFor(); assert.ok(await badges(page).count() >= 4);
  await page.screenshot({ path:path.join(output,'materials-light.png'),fullPage:true });
  await page.goto(origin + '/app/projects/' + projectId + '/assessment?section=standards');
  await page.getByRole('button', {name:'新建标准',exact:true}).click();
  for (const label of ['标准名称','评分维度名称','评分权重（%）']) await mark(page,label);
  await page.goto(origin + '/app/projects/' + projectId + '/team');
  await page.getByRole('heading',{name:'成员与任务负荷',exact:true}).waitFor(); await page.locator('.team-member').waitFor(); assert.ok(await badges(page).count() >= 4);
  observations.push('material editor, standard inputs and member workload marked');
  const other = await context.newPage(); await other.goto(origin + '/app/projects/' + projectId + '/tasks');
  await other.getByRole('button',{name:'缓存任务',exact:true}).waitFor();
  await other.getByRole('button',{name:'新建任务',exact:true}).click();
  assert.ok(await other.getByRole('dialog').locator('[data-ai-reference-badge]').count()>=6);
  await page.goto(origin + '/app/settings/appearance');
  const toggle = page.getByRole('checkbox',{name:'显示 AI 内容引用标识',exact:true}); await toggle.waitFor(); assert.equal(await toggle.isChecked(),true);
  await page.getByLabel('主题',{exact:true}).last().selectOption('dark');
  const darkStyle=await badges(page).first().evaluate(el=>({color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));
  assert.equal(darkStyle.color,'rgb(182, 213, 255)'); assert.equal(darkStyle.background,'rgb(33, 60, 97)');
  await page.screenshot({path:path.join(output,'settings-dark.png'),fullPage:true});
  await toggle.uncheck(); assert.equal(await badges(page).count(),0);
  await other.waitForFunction(()=>!document.querySelector('[data-ai-reference-badge]'));
  await page.reload(); assert.equal(await page.getByRole('checkbox',{name:'显示 AI 内容引用标识',exact:true}).isChecked(),false);
  await page.goto(origin + '/app/projects/' + projectId + '/tasks'); await page.getByRole('button',{name:'缓存任务',exact:true}).waitFor(); assert.equal(await badges(page).count(),0);
  await page.goto(origin + '/app/settings/appearance'); await page.getByRole('checkbox',{name:'显示 AI 内容引用标识',exact:true}).check();
  await other.waitForFunction(()=>Boolean(document.querySelector('[data-ai-reference-badge]')));
  observations.push('user setting hides every badge, persists after reload, updates another tab including portal form and can restore');
  assert.deepEqual(errors,[]); assert.equal(syncWrites,0); assert.equal(taskWrites,0);
  writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:observations,style,darkStyle,errors},null,2));
  console.log(JSON.stringify({passed:true,checks:observations,errors}));
} catch(error) {
  for (const page of context.pages()) { console.error(await page.locator('body').innerText()); await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}); break; }
  throw error;
} finally { await context.close(); }
