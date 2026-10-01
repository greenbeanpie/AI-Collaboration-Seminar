// Loopback-only browser fixture. No real accounts, credentials or production API.
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5196';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Loopback only');
const now = '2026-10-01T01:00:00Z';
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 try {
  for (const role of ['owner', 'member']) {
   const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
   const errors = []; page.on('pageerror', error => errors.push(error.message));
   let task = { taskId: 't1', title: '完成产品原型', detail: '三个关键页面和交互说明', criteria: '提供三个可操作页面，说明移动端适配情况', effortHours: 4, revision: 1, assigneeId: null, lifecycleState: 'open', parentTaskId: null, currentSubmissionId: null, status: 'todo', createdAt: now, updatedAt: now };
   let settings = { assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
   let submissions = [];
   await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname; const method = route.request().method(); const body = method === 'GET' ? null : route.request().postDataJSON();
    let data = { items: [], nextCursor: null };
    if (path === '/api/v1/auth/session') data = { user: { id: 'm1', username: 'fixture', displayName: '测试成员', email: null, role: 'user', isAdmin: false } };
    else if (path === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false }, limits: { assignmentSuggestionMaxTasks: 20 }, competitionTemplate: {} };
    else if (path === '/api/v1/projects/p1') data = { projectId: 'p1', name: '协作闭环验证', description: '仅本地模拟数据', myRole: role, status: 'active', revision: 1, deadlineDate: null, deadlinePrecision: 'unknown', updatedAt: now };
    else if (path.endsWith('/collaboration/settings')) { if (method === 'PATCH') settings = { ...settings, ...body, revision: settings.revision + 1 }; data = settings; }
    else if (path.endsWith('/collaboration/tasks')) data = { items: [task], nextCursor: null };
    else if (path.endsWith('/claim')) { assert.equal(body.expectedRevision, task.revision); task = { ...task, assigneeId: 'm1', revision: task.revision + 1, lifecycleState: 'in_progress' }; data = task; }
    else if (path.endsWith('/submissions')) {
     if (method === 'POST') {
      assert.equal(body.expectedRevision, task.revision); assert.deepEqual(body.materialVersionIds, ['v1']);
      const submission = { submissionId: `s${submissions.length + 1}`, taskId: 't1', round: submissions.length + 1, submittedBy: 'm1', body: body.body, materialVersionIds: body.materialVersionIds, materialVersions: [{ versionId: 'v1', materialId: 'mat1', title: '原型说明', revision: 4 }], criteria: task.criteria, status: 'pending', aiDecision: null, aiFeedback: null, aiReport: null, decision: null, feedback: null, revision: 1, evaluationJobId: null, evaluationAttempts: 0, evaluationError: 'AI 未启用', createdAt: now, updatedAt: now };
      submissions.unshift(submission); task = { ...task, currentSubmissionId: submission.submissionId, revision: task.revision + 1, lifecycleState: 'submitted' }; data = submission;
     } else data = { items: submissions };
    } else if (path.endsWith('/decide')) {
     const submission = submissions.find(item => path.includes(item.submissionId)); assert.equal(body.expectedRevision, submission.revision);
     Object.assign(submission, { decision: body.decision, feedback: body.feedback, status: body.decision, revision: submission.revision + 1 });
     task = { ...task, lifecycleState: body.decision === 'accept' ? 'accepted' : body.decision, revision: task.revision + 1 }; data = submission;
    } else if (path.endsWith('/members/me')) data = { userId: 'm1', displayName: '测试成员', role, skills: ['界面设计'], major: '计算机科学', hoursPerWeek: 8 };
    else if (path.endsWith('/members')) data = { items: [{ userId: 'm1', displayName: '测试成员', role, skills: [], major: '', hoursPerWeek: 8 }], nextCursor: null };
    else if (path.endsWith('/materials')) data = { items: [{ materialId: 'mat1', title: '原型说明', revision: 4 }], nextCursor: null };
    else if (path.endsWith('/versions')) data = { items: [{ versionId: 'v1', revision: 4, markdown: '三个页面已实现', attachments: [], createdAt: now }], nextCursor: null };
    else if (path.endsWith('/versions/v1')) data = { versionId: 'v1', revision: 4, markdown: '三个页面已实现，支持移动端布局', attachments: [], createdAt: now };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, requestId: 'collaboration-ui-fixture' }) });
   });
   await page.goto(origin + '/app/projects/p1/tasks');
   await page.getByRole('heading', { name: '协作任务闭环' }).waitFor();
   assert.equal(await page.getByRole('button', { name: '新建协作任务' }).count(), role === 'owner' ? 1 : 0);
   await page.getByRole('button', { name: '我来认领' }).click();
   await page.getByRole('button', { name: '查看与提交' }).click();
   await page.getByLabel('成果说明', { exact: true }).fill('已完成三个页面，请验收');
   await page.getByLabel('绑定材料版本', { exact: false }).selectOption('mat1');
   await page.getByRole('checkbox').check();
   await page.getByRole('button', { name: '提交本轮成果' }).click();
   await page.getByText('第 1 轮', { exact: true }).waitFor();
   assert.equal(await page.getByRole('button', { name: '确认验收决定' }).count(), role === 'owner' ? 1 : 0);
   await page.getByText('本轮验收标准与绑定版本', { exact: true }).click();
   await page.getByText('原型说明 · 固定版本 r4', { exact: true }).click();
   await page.getByText('三个页面已实现，支持移动端布局', { exact: true }).waitFor();
   await page.screenshot({ path: `/tmp/collaboration-${role}-desktop.png`, fullPage: true });
   if (role === 'owner') {
    const reviewDecision = page.getByRole('button', { name: '已核对最新评价，重新填写决定' });
    if (await reviewDecision.isVisible()) await reviewDecision.click();
    await page.getByLabel('第 1 轮验收结论').selectOption('improve');
    await page.getByLabel('第 1 轮验收理由').fill('补充错误反馈');
    await page.getByRole('button', { name: '确认验收决定' }).click();
    await page.getByRole('heading', { name: '提交新一轮成果' }).waitFor();
    await page.getByRole('button', { name: '已核对标准，重新填写本轮提交' }).click();
    await page.getByLabel('成果说明', { exact: true }).fill('已补充错误反馈');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '提交本轮成果' }).click();
    await page.getByLabel('第 2 轮验收理由').waitFor();
    if (await reviewDecision.isVisible()) await reviewDecision.click();
    await page.getByLabel('第 2 轮验收理由').fill('逐项核验通过');
    await page.getByRole('button', { name: '确认验收决定' }).click();
    await page.getByText('验收决定：通过', { exact: true }).waitFor();
    assert.equal(submissions.length, 2); assert.equal(submissions[1].feedback, '补充错误反馈');
   }
   await page.setViewportSize({ width: 390, height: 844 });
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No mobile overflow');
   await page.screenshot({ path: `/tmp/collaboration-${role}-mobile.png`, fullPage: true });
   await page.getByRole('button', { name: '关闭', exact: true }).click();
   assert.equal(await page.getByRole('dialog').count(), 0);
   assert.deepEqual(errors, []);
   await page.close();
  }
  console.log('PASS: owner/member claim, version-bound submission, immutable preview, owner improve-resubmit-accept history, mobile layout, modal close, no console errors');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
