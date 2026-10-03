// Loopback-only UI fixture. No real users, credentials, project writes or AI requests.
// Start: npm run dev --prefix frontend -- --host 127.0.0.1 --port 5181
// Run: UI_PLAYWRIGHT_PATH=/path/to/playwright node scripts/verify-ai-clarification-ui.cjs
const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const origin = process.env.UI_ORIGIN || 'http://127.0.0.1:5181';
const output = process.env.UI_OUTPUT_DIR || '/tmp/ai-clarification-ui';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Loopback only');
mkdirSync(output, { recursive: true });
const baseQuestion = { id: 'question-fixture', question: '这次项目主要面向哪个参与赛道？', reason: '赛道会改变交付范围和验收要求，现有资料还不能确定。', options: ['技术创新与产品实践', '社会调研与公共服务'], allowUndecided: true, round: 1, maxRounds: 3, status: 'pending', revision: 1, createdAt: '2026-10-03T08:00:00Z' };
const user = { id: 'fixture-owner', username: 'fixture', displayName: '界面验证用户', email: null, role: 'user', isAdmin: false };
const project = { id: 'fixture-project', name: '澄清交互测试', description: '仅限本机模拟数据', status: 'active', myRole: 'owner', revision: 1, aiCollaborationEnabled: true };
const capabilities = { features: { aiEnabled: true, webSearchEnabled: false, pushEnabled: false }, limits: { maxFileBytes: 10485760 } };

async function scenario(browser, scope, action, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let question = { ...baseQuestion };
  let pending = true;
  let jobStatus = 'waiting_input';
  let failOnce = action === 'retry';
  const writes = [];
  let draft = { id: 'fixture-draft', status: 'active', revision: 8, payload: { name: project.name, description: project.description, brief: '', teamSize: 3, inviteUsernames: [], inviteLabels: [], aiCollaborationEnabled: true }, preview: null, previewRevision: null, previewAttemptId: 'same-preview', previewState: 'waiting_input', previewError: null, clarification: question, files: [], removedFiles: [], projectId: null, updatedAt: '2026-10-03T08:00:00Z' };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname;
    const method = route.request().method();
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'local-fixture' }) });
    if (!['GET', 'HEAD'].includes(method)) {
      assert.match(path, /\/clarifications\/question-fixture\/(answer|cancel)$/u, 'Only clarification mutations are allowed');
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      if (failOnce) {
        failOnce = false;
        question = { ...question, revision: 2 };
        draft = { ...draft, clarification: question };
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: '问题版本发生变化，请重新核对', retryable: false }, requestId: 'local-fixture-conflict' }) });
      }
      assert.equal(body.expectedRevision, question.revision);
      pending = false;
      const cancelled = path.endsWith('/cancel');
      jobStatus = cancelled ? 'cancelled' : 'succeeded';
      draft = { ...draft, clarification: { ...question, status: cancelled ? 'cancelled' : 'answered' }, previewState: cancelled ? 'none' : 'ready', previewRevision: cancelled ? null : draft.revision, preview: cancelled ? null : { mode: 'ai', goal: { title: '完成共同适用的基础工作', detail: '未决定的赛道仍然保留，待团队确认' }, tasks: [] } };
      return respond(scope === 'draft' ? draft : { jobId: 'fixture-job', status: cancelled ? 'cancelled' : 'queued' });
    }
    if (path === '/api/v1/auth/session') return respond({ user });
    if (path === '/api/v1/capabilities') return respond(capabilities);
    if (path === '/api/v1/creation-drafts') return respond({ items: [draft] });
    if (path === '/api/v1/creation-drafts/fixture-draft') return respond(draft);
    if (path === '/api/v1/projects/fixture-project') return respond(project);
    if (path === '/api/v1/projects/fixture-project/ai/clarifications') return respond({ items: pending ? [{ ...question, jobId: 'fixture-job' }] : [] });
    if (path === '/api/v1/jobs/fixture-job') return respond({ jobId: 'fixture-job', status: jobStatus, result: pending ? { clarification: question } : {}, attempts: 1 });
    if (path.endsWith('/collaboration/settings')) return respond({ aiCollaborationEnabled: true, planningMode: 'automatic', assignmentMode: 'automatic', evaluationMode: 'manual', revision: 1 });
    if (path.endsWith('/goal')) return respond({ projectId: project.id, title: '共同目标', detail: '', revision: 1, graphRevision: 1 });
    if (path.endsWith('/members/me')) return respond({ userId: user.id, displayName: user.displayName, role: 'owner' });
    if (path.endsWith('/members')) return respond({ items: [{ userId: user.id, displayName: user.displayName, role: 'owner' }], nextCursor: null });
    if (path.endsWith('/notifications/settings')) return respond({ enabled: false, preferences: {} });
    return respond({ items: [], nextCursor: null });
  });
  const route = scope === 'draft' ? '/app/projects/new/wizard?draftId=fixture-draft' : '/app/projects/fixture-project/tasks';
  const open = async () => {
    if (scope === 'project') await page.getByRole('button', { name: '回答 AI 的问题（1）' }).click();
    await page.getByRole('region', { name: 'AI 需要你补充信息' }).waitFor();
  };
  try {
    await page.goto(origin + route);
    await open();
    assert.equal(writes.length, 0, 'A pending question must not mutate the project');
    await page.reload();
    await open();
    assert.equal(await page.getByRole('button', { name: '提交回答并继续' }).isDisabled(), true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `${scope}/${action}/${width}: mobile page overflow`);
    const card = page.getByRole('region', { name: 'AI 需要你补充信息' });
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${scope}-${action}-${width}-pending.png`, fullPage: true });
    if (action === 'option') {
      await page.getByRole('radio', { name: baseQuestion.options[0] }).check();
      await page.getByRole('button', { name: '提交回答并继续' }).click();
    } else if (action === 'text' || action === 'retry') {
      await page.getByLabel('补充回答', { exact: true }).fill('团队先开展共同适用的基础调研，赛道尚未决定');
      if (scope === 'project') {
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await open();
        assert.equal(await page.getByLabel('补充回答', { exact: true }).inputValue(), '团队先开展共同适用的基础调研，赛道尚未决定');
      }
      await page.getByRole('button', { name: '提交回答并继续' }).click();
      if (action === 'retry') {
        await page.getByText('问题状态已更新，已重新读取。你的输入仍保留，请核对当前问题后再提交。').waitFor();
        assert.equal(await page.getByLabel('补充回答', { exact: true }).inputValue(), '团队先开展共同适用的基础调研，赛道尚未决定');
        await page.getByRole('button', { name: '提交回答并继续' }).click();
      }
    } else if (action === 'undecided') await page.getByRole('button', { name: '尚未决定，先保留未决范围' }).click();
    else await page.getByRole('button', { name: '取消本次 AI 操作' }).click();
    await card.waitFor({ state: 'detached' });
    assert.equal(writes.length, action === 'retry' ? 2 : 1);
    const last = writes.at(-1);
    if (action === 'option') assert.equal(last.body.option, baseQuestion.options[0]);
    if (action === 'undecided') assert.deepEqual(last.body, { expectedRevision: 1, undecided: true });
    if (action === 'cancel') assert.deepEqual(last.body, { expectedRevision: 1 });
    if (action === 'retry') assert.equal(last.body.expectedRevision, 2);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.screenshot({ path: `${output}/${scope}-${action}-${width}-resolved.png`, fullPage: true });
    console.log(`PASS ${scope} / ${action} / ${width}px: reload, answer/cancel, zero premature mutations, no overflow or page errors`);
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [1280, 390]) for (const scope of ['draft', 'project']) for (const action of ['option', 'text', 'undecided', 'retry', 'cancel']) await scenario(browser, scope, action, width);
    console.log(`PASS: 20 clarification UI flows. Screenshots: ${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
