/** Local browser acceptance with HTTP fixtures; no production/model calls.
 * node scripts/verify-task-agent-ui.mjs [preview-url] [output-directory]
 * PLAYWRIGHT_MODULE can point to an installed Playwright package.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = process.argv[2] || 'http://127.0.0.1:5175';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const out = resolve(process.argv[3] || 'output/task-agent-ui');
await mkdir(out, { recursive: true });
const report = { fixtureOnly: true, checks: [], errors: [], screenshots: [] };
const now = '2026-10-03T09:00:00Z';
const projectId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const base = `/app/projects/${projectId}`;
const standard = { standardsVersionId: 'std', projectId, title: '项目质量标准', version: 1, revision: 1, status: 'confirmed', requirements: [{ requirementId: 'req', title: '页面可操作', detail: '桌面与手机均可使用', category: 'deliverable', dueDate: null, citations: [] }], mappings: [{ requirementId: 'req', dimensionKey: 'quality' }], rubric: { weights: [{ key: 'quality', label: '交付质量', weight: 100 }], notes: '' }, createdAt: now };
const task = { taskId: 't1', title: '完成产品原型', detail: '实现三个页面与交互说明', criteria: '提供三个可操作页面并验证移动端', effortHours: 4, revision: 1, assigneeId: userId, lifecycleState: 'in_progress', status: 'doing', dependsOnTaskIds: ['t0'], unfinishedDependencyIds: [], currentSubmissionId: null, createdAt: now, updatedAt: now };
const upstream = { ...task, taskId: 't0', title: '完成用户研究', detail: '已完成访谈', criteria: '访谈记录', lifecycleState: 'accepted', status: 'done', dependsOnTaskIds: [] };
const submissions = [2, 1].map(round => ({ submissionId: `submission-${round}`, taskId: task.taskId, round, submittedBy: userId, body: `第 ${round} 轮历史成果`, materialVersionIds: [], criteria: task.criteria, status: 'evaluated', aiDecision: null, aiFeedback: null, aiReport: null, decision: 'improve', feedback: '继续完善', revision: 1, evaluationAttempts: 0, createdAt: now }));
const browser = await chromium.launch({ headless: true, executablePath: process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
let activePage;
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    const writes = [];
    let provisional = false;
    let humanReviewed = false;
    let showProposal = false;
    let submissionMode = null;
    let submittedRound = false;
    let evaluationJobReads = 0;
    let submissionCreates = 0;
    let currentStandard = { ...standard, active: true };
    let standardHistory = [currentStandard];
    const automaticSubmission = () => ({ ...submissions[0], submissionId: 'auto-submission', round: 3, status: 'pending', decision: null, revision: 1, feedback: null, evaluationJobId: submissionMode === 'enabled' ? 'evaluation-once' : null, evaluationAttempts: submissionMode === 'enabled' ? 1 : 0 });
    let releaseTaskChunk;
    const taskChunkGate = new Promise(resolveGate => { releaseTaskChunk = resolveGate; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(origin).origin) return route.abort();
      if (width === 1440 && /\/TasksPage(?:\.tsx|-[^/]+\.js)/.test(url.pathname)) await taskChunkGate;
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const p = url.pathname, method = route.request().method();
      if (method !== 'GET') writes.push({ p, method, body: route.request().postDataJSON() });
      let data = { items: [], nextCursor: null };
      if (p.endsWith('/auth/session')) data = { user: { id: userId, username: 'fixture', displayName: '测试成员', role: 'user', isAdmin: false } };
      else if (p.endsWith('/capabilities')) data = { features: { aiEnabled: submissionMode === 'enabled' }, limits: { maxFileBytes: 20000000 }, competitionTemplate: {} };
      else if (p === `/api/v1/projects/${projectId}`) data = { projectId, name: '任务交接验证', description: '本地浏览器固定数据', status: 'active', myRole: 'owner', revision: 1 };
      else if (p.endsWith('/members/me')) data = { userId, displayName: '测试成员', role: 'owner' };
      else if (p.endsWith('/members')) data = { items: [{ userId, displayName: '测试成员', role: 'owner' }], nextCursor: null };
      else if (p.endsWith('/goal')) data = { title: '发布可用原型', detail: '交付三个页面', revision: 2, graphRevision: 1 };
      else if (p.endsWith('/agent-eligibility') && method === 'GET') data = { status: 'ready', taskRevision: submittedRound && p.includes('/tasks/t1/') ? 2 : 1, sourceHash: 'local-ui-fixture', eligible: true, reason: '该任务可以通过已有资料完整执行。', jobId: 'fixture-eligibility' };
      else if (p.endsWith('/tasks')) data = { items: [submittedRound ? { ...task, lifecycleState: 'submitted', currentSubmissionId: 'auto-submission', revision: 2 } : provisional || humanReviewed ? { ...task, lifecycleState: 'accepted', status: 'done', currentSubmissionId: submissions[0].submissionId, pendingHumanReview: provisional } : task, upstream], nextCursor: null };
      else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: submissionMode === 'enabled', assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
      else if (p.endsWith('/collaboration/feedback/current')) data = { version: 0, feedback: '' };
      else if (p.endsWith('/collaboration/proposals')) data = { items: showProposal ? [{ proposalId: 'proposal-1', kind: 'decompose', status: 'pending', revision: 1, createdAt: now, payload: { tasks: [{ key: 'report', title: '写报告并制作图表', detail: '整理研究结果与图表', criteria: '交付完整报告', effortHours: 6, dependsOn: [] }], updates: [] } }] : [], nextCursor: null };
      else if (p.endsWith('/jobs/evaluation-once')) { evaluationJobReads++; data = { jobId: 'evaluation-once', status: 'running', attempts: 1 }; }
      else if (p.endsWith('/submissions')) {
        if (method === 'POST') { submissionCreates++; submittedRound = true; data = automaticSubmission(); }
        else data = { items: submittedRound ? [automaticSubmission(), ...submissions] : provisional || humanReviewed ? [{ ...submissions[0], status: 'accept', decision: 'accept', pendingHumanReview: provisional, revision: humanReviewed ? 2 : 1 }, submissions[1]] : submissions };
      }
      else if (p.endsWith('/decide')) {
        const body = route.request().postDataJSON();
        assert.equal(body.decision, 'accept');
        assert.equal(body.expectedRevision, 1);
        assert.equal(body.feedback, '已人工核对附件与链接');
        provisional = false; humanReviewed = true;
        data = { ...submissions[0], status: 'accept', decision: 'accept', pendingHumanReview: false, revision: 2 };
      }
      else if (p.endsWith('/inquiries')) data = { items: [], candidates: [{ taskId: 't0', title: upstream.title, recipientName: '测试成员', recipientSource: 'completion' }] };
      else if (p.endsWith('/standards/generate')) data = { jobId: 'standard-job' };
      else if (p.endsWith('/jobs/standard-job')) data = { jobId: 'standard-job', status: 'succeeded', result: { draft: { title: '自动生成标准', requirements: [{ title: 'AI 交付要求', detail: '验证生成草稿可编辑', category: 'deliverable', dueDate: null, duePrecision: 'unknown', dimensionKey: 'quality' }], weights: [{ key: 'quality', label: '成果质量', weight: 100 }], notes: '根据项目目标整理' } } };
      else if (p.endsWith('/standards/current')) data = { standard: currentStandard };
      else if (p.endsWith('/standards')) {
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          currentStandard = { ...currentStandard, title: body.title, version: 2, standardsVersionId: 'latest-standard', rubric: { ...currentStandard.rubric, weights: body.weights, notes: body.notes }, requirements: body.requirements.map((requirement, index) => ({ ...requirement, requirementId: `requirement-${index}`, citations: requirement.citations ?? [] })), mappings: body.requirements.flatMap((requirement, index) => requirement.dimensionKey ? [{ requirementId: `requirement-${index}`, dimensionKey: requirement.dimensionKey }] : []) };
          standardHistory = [currentStandard, { ...standard, active: false }]; data = currentStandard;
        } else data = { items: standardHistory };
      }
      else if (p.endsWith('/materials')) data = { items: [{ materialId: 'mat', title: '访谈记录', currentVersionId: 'v1', revision: 1 }], nextCursor: null };
      else if (p.endsWith('/materials/mat/versions/v1')) data = { versionId: 'v1', materialId: 'mat', revision: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '访谈材料正文与用户需求' }] }] }, markdown: '访谈材料正文与用户需求', attachments: [], createdAt: now };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, requestId: 'local-ui-fixture' }) });
    });
    const capture = async name => { const file = resolve(out, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file); };
    await page.goto(origin + base + '/tasks', { waitUntil: 'domcontentloaded' });
    if (width === 1440) {
      await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
      await page.getByRole('navigation', { name: '项目功能', exact: true }).waitFor();
      await page.getByText('正在打开项目内容', { exact: true }).waitFor();
      assert.equal(await page.locator('.center-screen').count(), 0);
      await capture('confined-loading');
      releaseTaskChunk();
    }
    const card = page.locator('.collab-task').filter({ has: page.getByRole('button', { name: task.title, exact: true }) });
    await card.getByRole('button', { name: '查看与提交', exact: true }).waitFor();
    await page.getByRole('heading', { name: '任务', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '新建任务', exact: true }).count(), 1);
    assert.equal(await page.getByText(/历史父任务|子任务进度/).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await capture('task-actions');
    await card.getByRole('button', { name: '前置任务质询', exact: true }).click();
    const inquiry = page.getByRole('dialog');
    await inquiry.getByLabel('询问哪项前置任务').waitFor();
    assert.equal(await inquiry.locator('[role=tablist], [role=tab], [role=tabpanel]').count(), 0);
    await capture('inquiry');
    await inquiry.getByRole('button', { name: '关闭', exact: true }).click();
    await card.getByRole('button', { name: '查看与提交', exact: true }).click();
    await page.getByLabel('成果说明', { exact: true }).fill('未提交的工作草稿');
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: '请求 AI 评价', exact: true }).count(), 0);
    assert.equal(await page.getByRole('dialog').locator('[role=tablist], [role=tab], [role=tabpanel]').count(), 0);
    assert.equal(await page.getByRole('dialog').getByRole('heading', { name: '前置任务质询', exact: true }).count(), 0);
    assert.equal(await page.getByText('AI 自主调查相关项目资料', { exact: false }).count(), 0);
    await capture('submission');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await card.getByRole('button', { name: '任务设置', exact: true }).click();
    await page.getByRole('dialog').getByRole('heading', { name: '任务介绍', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').locator('[role=tablist], [role=tab], [role=tabpanel]').count(), 0);
    await capture('settings');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await card.getByRole('button', { name: '查看与提交', exact: true }).click();
    assert.equal(await page.locator('.collab-submit textarea').inputValue(), '未提交的工作草稿');
    const historyButton = page.getByRole('dialog').getByRole('button', { name: '查看历史记录', exact: true });
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: /更多/ }).count(), 0);
    assert((await historyButton.boundingBox()).y < (await page.locator('.collab-submit textarea').boundingBox()).y);
    await historyButton.click();
    await page.getByText('第 2 轮历史成果', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByText('第 1 轮历史成果', { exact: true }).waitFor();
    await capture('submission-history');
    await page.getByRole('button', { name: '返回任务操作', exact: true }).first().click();
    assert.equal(await page.locator('.collab-submit textarea').inputValue(), '未提交的工作草稿');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await card.getByRole('button', { name: '交给本地 Agent', exact: true }).click();
    const handoff = page.getByRole('dialog');
    await handoff.getByRole('button', { name: /复制/ }).waitFor();
    const prompt = handoff.locator('textarea');
    await prompt.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] textarea')].some(el => el.value.includes('访谈材料正文')));
    const text = await prompt.inputValue();
    for (const required of [task.title, task.criteria, '发布可用原型', '页面可操作', upstream.title, '访谈材料正文']) assert(text.includes(required), `prompt missing ${required}`);
    assert.equal(await handoff.locator('[role=tablist], [role=tab], [role=tabpanel]').count(), 0);
    await handoff.getByRole('button', { name: '复制提示词', exact: true }).click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), text);
    const downloadPromise = page.waitForEvent('download');
    await handoff.getByRole('button', { name: /下载/ }).click();
    const download = await downloadPromise;
    assert(download.suggestedFilename().endsWith('.md'));
    await download.saveAs(resolve(out, `handoff-${width}.md`));
    assert.deepEqual(writes, [], 'opening dialogs and exporting prompt must not write task state');
    await capture('agent-prompt');
    await handoff.getByRole('button', { name: '关闭', exact: true }).click();
    await page.goto(origin + base + '/assessment?section=standards');
    await page.getByRole('heading', { name: '项目标准', exact: true }).waitFor();
    assert.equal(await page.getByText('页面可操作', { exact: true }).count(), 1);
    await capture('standards');
    await page.getByRole('button', { name: 'AI 生成标准', exact: true }).click();
    await page.getByLabel('标准名称', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('标准名称', { exact: true }).inputValue(), '自动生成标准');
    await page.getByLabel('要求 1 标题', { exact: true }).fill('人工修订生成要求');
    assert.deepEqual(writes.map(write => write.p), [`/api/v1/projects/${projectId}/standards/generate`]);
    await capture('generated-standard');
    await page.getByRole('button', { name: '保存并生效', exact: true }).click();
    await page.getByText('生效标准 v2', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /确认.*标准/ }).count(), 0);
    assert.equal(writes.filter(write => write.p.endsWith('/confirm')).length, 0);
    await page.getByRole('button', { name: '材料检查', exact: true }).click();
    await page.getByText('生效标准：自动生成标准 · v2', { exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: /标准/ }).count(), 0);
    await capture('effective-standard-no-selection');
    await page.goto(origin + base + '/tasks');
    await card.getByRole('button', { name: '交给本地 Agent', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] textarea')].some(element => element.value.includes('人工修订生成要求')));
    const updatedPrompt = await page.getByRole('dialog').locator('textarea').inputValue();
    assert(updatedPrompt.includes('自动生成标准 · v2'));
    assert(!updatedPrompt.includes('项目质量标准 · v1'));
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    provisional = true;
    await page.goto(origin + base + '/tasks');
    const pendingCard = page.locator('.collab-task').filter({ has: page.getByRole('button', { name: task.title, exact: true }) });
    await pendingCard.getByText('已完成（待人工审核）', { exact: true }).waitFor();
    assert.equal(await page.getByText('共 2 项 · 已完成 2 项', { exact: true }).count(), 1);
    await page.getByLabel('筛选', { exact: true }).selectOption('pending_review');
    assert.equal(await page.locator('.collab-task').count(), 1);
    await pendingCard.getByRole('button', { name: '查看与提交', exact: true }).click();
    await page.getByRole('dialog').getByRole('heading', { name: '人工审核', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: '请求 AI 评价', exact: true }).count(), 0);
    await capture('pending-human-review');
    await page.getByLabel('第 2 轮验收理由', { exact: true }).fill('已人工核对附件与链接');
    await page.getByRole('button', { name: '确认人工审核', exact: true }).click();
    await page.getByRole('dialog').getByRole('heading', { name: '负责人明确验收', exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByLabel('筛选', { exact: true }).selectOption('accepted');
    assert.equal(await page.locator('.collab-task').count(), 2);
    assert.equal(await page.locator('.collab-task').getByText('已完成（待人工审核）', { exact: true }).count(), 0);
    showProposal = true;
    await page.goto(origin + base + '/tasks');
    await page.getByRole('button', { name: 'AI 拆解、调整与分工', exact: true }).click();
    await page.getByText('修正建议、部分应用或重新反馈', { exact: true }).click();
    await page.getByRole('button', { name: '保存方案修正', exact: true }).waitFor();
    await page.getByRole('button', { name: '应用选中条目', exact: true }).waitFor();
    await capture('proposal-edit-entry');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    for (const mode of ['enabled', 'disabled']) {
      provisional = false; humanReviewed = false; showProposal = false; submittedRound = false; submissionMode = mode; evaluationJobReads = 0; submissionCreates = 0;
      await page.goto(origin + base + '/tasks');
      await card.getByRole('button', { name: '查看与提交', exact: true }).click();
      await page.getByLabel('成果说明', { exact: true }).fill(`本轮成果：${mode}`);
      await page.getByRole('button', { name: '提交本轮成果', exact: true }).click();
      await page.getByText('第 3 轮', { exact: true }).waitFor();
      assert.equal(submissionCreates, 1);
      assert.equal(await page.getByRole('dialog').getByRole('button', { name: '请求 AI 评价', exact: true }).count(), 0);
      if (mode === 'enabled') { await page.getByText('AI 任务：处理中', { exact: true }).waitFor(); assert(evaluationJobReads >= 1); }
      else assert.equal(evaluationJobReads, 0);
      assert.equal(writes.filter(write => write.p.endsWith('/evaluate')).length, 0);
      await capture(`automatic-evaluation-${mode}`);
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    }
    report.checks.push({ width, passed: true, verified: 'task actions, independent dialogs, draft and history preservation, full prompt, clipboard and download, no writes during handoff, provisional completion and human review, proposal editing entry, no tabs, no overflow' });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(error.stack); if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }); await writeFile(resolve(out, 'failure.txt'), await activePage.locator('body').innerText()); } process.exitCode = 1; }
finally { await browser.close(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
