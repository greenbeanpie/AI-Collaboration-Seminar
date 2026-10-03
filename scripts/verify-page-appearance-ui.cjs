// Loopback fixture: real React app, no production writes, accounts, or model calls.
// --serve starts loopback fixtures + Vite; default verifies the page appearance changes.
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:5198';
const now = '2026-10-02T12:00:00Z';
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const task = { taskId: 't1', title: '演示文稿结构与 5 分钟答辩提纲', detail: '按收集数据、分析、演示的主线组织文稿，说明背景、方法、样本来源、结果与限制，所有缺少验证的数据保留待填写标记，提交五分钟的演示结构及讲稿骨架。', criteria: '提交完整演示结构和讲稿骨架，保留所有待验证标记。', effortHours: 3, revision: 7, assigneeId: 'u', lifecycleState: 'improve', currentSubmissionId: 's3', status: 'doing', dependsOnTaskIds: [], unfinishedDependencyIds: [], createdAt: now, updatedAt: now, summary: '组织五分钟演示结构与讲稿骨架，覆盖报告要点，保留待验证数据标记。', summaryStatus: 'ready', summarySourceHash: 'fixture-t1' };
const versions = Array.from({ length: 12 }, (_, i) => ({ versionId: `v${12 - i}`, materialId: 'mat1', revision: 12 - i, createdAt: now, origin: 'manual', doc: doc(`材料版本 ${12 - i} 正文`), attachments: [] }));
const material = { materialId: 'mat1', title: '演示结构文档', kind: 'document', purpose: 'output', revision: 12, currentVersionId: 'v12', currentVersion: versions[0], updatedAt: now, createdAt: now };
const source = { sourceId: 'src1', title: '导入项目通知', purpose: 'reference', revision: 1, currentVersionId: 'srcv1', kind: 'paste', createdAt: now, lifecycleVersion: 1, canDelete: true, deletedAt: null, fileId: null };
let fixtureRole = 'admin';
let comments = [];
function reset() { comments = Array.from({ length: 12 }, (_, i) => ({ commentId: `c${i}`, authorName: '测试成员', authorId: 'u', body: `讨论内容 ${i + 1}`, createdAt: new Date(Date.parse(now) - i * 60000).toISOString(), targetType: 'material', targetId: 'mat1' })); }
reset();
const submissions = [3, 2, 1].map(round => ({ submissionId: `s${round}`, taskId: 't1', round, submittedBy: 'u', body: `第 ${round} 轮成果说明：已提交演示结构与材料，请核验来源。`, materialVersionIds: ['v12'], materialVersions: [{ versionId: 'v12', materialId: 'mat1', title: material.title, revision: 12 }], criteria: `第 ${round} 轮固定验收标准`, status: 'evaluated', aiDecision: null, aiFeedback: null, aiReport: null, decision: 'improve', feedback: `第 ${round} 轮反馈：请补充来源核验。`, revision: 2, evaluationJobId: null, evaluationAttempts: 0, createdAt: now, updatedAt: now }));
function serve() {
  const apiServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:8798');
    const p = url.pathname;
    let data = { items: [], nextCursor: null };
    let body;
    if (req.method === 'POST') { let chunks = ''; for await (const chunk of req) chunks += chunk; body = chunks ? JSON.parse(chunks) : {}; }
    if (p.startsWith('/__fixture/role/')) fixtureRole = p.split('/').at(-1);
    else if (p === '/__fixture/reset') reset();
    else if (p === '/api/v1/auth/session') data = { user: { id: 'u', username: 'fixture', displayName: '测试成员', email: null, role: fixtureRole, isAdmin: fixtureRole !== 'user' } };
    else if (p === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false, webFetch: false, emailMode: 'disabled' }, limits: { maxFileBytes: 10485760, maxPdfPages: 30, pageImageMaxEdge: 2000, pageImageMaxBytes: 2097152, concurrentAiTasksPerProject: 2, listDefaultPageSize: 20, listMaxPageSize: 100 }, competitionTemplate: { teamSizeLimit: null } };
    else if (p === '/api/v1/projects/p') data = { projectId: 'p', name: '协作布局验收', description: '固定测试数据，无生产写入', myRole: 'owner', status: 'active', revision: 1, updatedAt: now };
    else if (p.endsWith('/goal')) data = { title: '完成演示', detail: '', revision: 1, graphRevision: 1 };
    else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual', revision: 1 };
    else if (p.endsWith('/collaboration/proposals')) data = { items: [3,2,1].map(i => ({ proposalId: 'proposal'+i, kind: 'assign', status: 'applied', revision: 1, createdAt: new Date(Date.parse(now)- (3-i)*60000).toISOString(), payload: { assignments: [{ taskId: 't1', reason: '建议记录 '+i, assigneeId: 'u' }] } })), nextCursor: null };
    else if (p.endsWith('/tasks')) data = { items: [task, { ...task, taskId: 't2', title: '样本采集（人工已有任务）', detail: '提交3条真实样本记录及来源说明，记录每条采集日期', criteria: '提交3条真实样本记录及来源说明，记录每条采集日期', lifecycleState: 'open', currentSubmissionId: null, assigneeId: null, effortHours: 1, summary: null }], nextCursor: null };
    else if (p.endsWith('/submissions')) data = { items: submissions };
    else if (p.endsWith('/members/me')) data = { userId: 'u', role: 'owner', displayName: '测试成员' };
    else if (p.endsWith('/members')) data = { items: [{ userId: 'u', role: 'owner', displayName: '测试成员', joinedAt: now }], nextCursor: null };
    else if (p.endsWith('/resource-library')) data = { items: [{ resourceType: 'material', resourceId: 'mat1', title: material.title, purpose: 'output', revision: 12, currentVersionId: 'v12', canManage: true, updatedAt: now }, { resourceType: 'source', resourceId: source.sourceId, title: source.title, purpose: source.purpose, revision: 1, currentVersionId: source.currentVersionId, canManage: true, updatedAt: now }], nextCursor: null };
    else if (p.endsWith('/sources')) data = { items: [source], nextCursor: null };
    else if (p.endsWith('/sources/src1/versions/srcv1')) data = { sourceVersionId: 'srcv1', sourceId: 'src1', revision: 1, origin: 'paste', fileId: null, status: 'ready', parseError: null, pageCount: null, charCount: 20, pages: [], processingJob: null };
    else if (p.endsWith('/sources/src1/versions/srcv1/processing')) data = { revision: 1, textStatus: 'ready', requirementsStatus: 'ready', summaryStatus: 'pending', summary: null };
    else if (p.endsWith('/materials')) data = { items: [material], nextCursor: null };
    else if (p.endsWith('/materials/mat1')) data = material;
    else if (p.endsWith('/materials/mat1/versions')) data = { items: versions, nextCursor: null };
    else if (p.includes('/materials/mat1/versions/')) data = versions.find(v => p.endsWith(`/${v.versionId}`));
    else if (p.endsWith('/comments')) {
      if (req.method === 'POST') { data = { commentId: 'new-comment', authorName: '测试成员', authorId: 'u', body: body.body, createdAt: now, targetType: 'material', targetId: 'mat1' }; comments.unshift(data); }
      else data = { items: comments, nextCursor: null };
    }
    res.writeHead(req.method === 'POST' && p.endsWith('/comments') ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data, requestId: 'compact-ui-fixture' }));
  });
  apiServer.listen(8798, '127.0.0.1');
  const vite = spawn(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5198'], { cwd: path.join(root, 'frontend'), env: { ...process.env, AI_OFFICE_API_TARGET: 'http://127.0.0.1:8798' }, stdio: 'inherit' });
  const stop = () => { vite.kill(); apiServer.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

async function verify() {
  const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
  const output = path.join(root, process.argv.includes('--material-overlays') ? 'output/material-overlays' : 'output/page-appearance'); mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH, headless: true });
  const report = { source: 'Real React app, isolated loopback fixtures, Chromium', checks: [], errors: [] };
  try {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      await fetch('http://127.0.0.1:8798/__fixture/role/admin');
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
      await context.addInitScript(value => localStorage.setItem('ai-office-theme', value), theme);
      const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
      const shot = name => page.screenshot({ path: path.join(output, `${name}-${width}-${theme}.png`), fullPage: true });
      const fits = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal page overflow');
      await page.goto(origin+'/app/projects/p/tasks');
      await page.getByRole('button', { name: 'AI 拆解、调整与分工', exact: true }).click();
      const ai = page.getByRole('dialog', { name: 'AI 拆解、调整与分工' }); await ai.waitFor();
      await ai.getByLabel('目标、补充信息或调整要求').fill('保留 AI 调整要求'); await shot('task-ai');
      await ai.getByRole('button', { name: /更多/ }).click();
      await page.keyboard.press('Escape'); assert(await ai.isVisible(), 'Escape from menu closes modal');
      await ai.getByRole('button', { name: /更多/ }).click();
      await ai.getByRole('button', { name: '查看历史版本' }).click();
      await page.getByLabel('选择建议记录').waitFor();
      assert.equal(await page.locator('.collab-proposal:visible').count(), 1);
      assert.equal(await page.getByLabel('选择建议记录').inputValue(), 'proposal3');
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByLabel('选择建议记录').locator('option[value="proposal2"]:checked').waitFor({ state: 'attached' });
      assert.equal(await page.getByLabel('选择建议记录').inputValue(), 'proposal2');
      await page.getByRole('button', { name: '返回任务操作' }).click();
      assert.equal(await ai.getByLabel('目标、补充信息或调整要求').inputValue(), '保留 AI 调整要求');
      await ai.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '查看与提交', exact: true }).first().click();
      const dialog = page.getByRole('dialog'); await dialog.getByLabel('成果说明').fill('未提交草稿仍保留');
      await dialog.getByRole('button', { name: /更多/ }).click();
      await dialog.getByRole('button', { name: '查看历史版本' }).click();
      const history = page.getByRole('region', { name: '提交与验收历史', exact: true });
      await history.waitFor(); assert.equal(await page.locator('[role="dialog"]:visible').count(), 0); assert.equal(await history.locator('.collab-history').count(), 1);
      assert.equal(await page.getByLabel('选择提交轮次').inputValue(), 's3');
      assert(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled());
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.waitForURL(/record=s2/);
      await page.getByLabel('选择提交轮次').locator('option[value="s2"]:checked').waitFor({ state: 'attached' });
      assert.equal(await page.getByLabel('选择提交轮次').inputValue(), 's2');
      await shot('task-history'); await fits();
      await page.goBack(); await page.getByLabel('选择提交轮次').locator('option[value="s3"]:checked').waitFor({ state: 'attached' }); assert.equal(await page.getByLabel('选择提交轮次').inputValue(), 's3');
      await page.getByRole('button', { name: '返回任务操作' }).click();
      assert.equal(await dialog.getByLabel('成果说明').inputValue(), '未提交草稿仍保留');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.goto(origin+'/app/projects/p/data');
      await page.getByRole('button', { name: /导出文件/ }).waitFor();
      const sidebar = page.getByRole('complementary', { name: '项目资料列表' });
      assert(await sidebar.getByRole('heading', { name: '资料浏览' }).isVisible());
      assert(await sidebar.getByRole('button', { name: '导入资料' }).isVisible());
      assert(await sidebar.getByRole('button', { name: '新建文档' }).isVisible());
      assert.equal(await page.locator('.resource-detail-panel h2').filter({ hasText: '演示结构文档' }).count(), 1);
      const card = page.locator('.tm-editor-card');
      assert(await card.getByLabel('修改资料用途').isVisible());
      assert(await card.getByRole('button', { name: '打开 AI 协助' }).isVisible());
      await page.getByRole('button', { name: /导出文件/ }).click();
      await shot('materials-export'); await fits();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Markdown', exact: true }).click();
      const download = await downloadPromise; await download.saveAs(path.join(output, `material-${width}-${theme}.md`));
      assert.equal(require('node:fs').readFileSync(path.join(output, `material-${width}-${theme}.md`), 'utf8').trim(), '材料版本 12 正文');
      await page.evaluate(() => { window.__printCalls = 0; window.print = () => window.__printCalls++; });
      await page.getByRole('button', { name: /导出文件/ }).click();
      await page.getByRole('button', { name: '打印 / PDF', exact: true }).click();
      await page.waitForFunction(() => window.__printCalls === 1);
      assert.equal(await page.locator('.tm-print-document').count(), 1);
      await page.getByRole('button', { name: '讨论', exact: true }).click();
      const discussion = page.getByRole('dialog', { name: '材料讨论' }); await discussion.waitFor();
      assert.equal(await discussion.locator('.tm-comment').count(), 5);
      await discussion.getByLabel('发表评论').fill('弹窗关闭后保留评论草稿');
      await discussion.getByRole('button', { name: '下一页', exact: true }).click();
      await discussion.getByText('讨论内容 6', { exact: true }).waitFor();
      await shot('material-discussion');
      await page.keyboard.press('Escape'); await discussion.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '讨论', exact: true }).click();
      await discussion.waitFor();
      assert.equal(await discussion.getByLabel('发表评论').inputValue(), '弹窗关闭后保留评论草稿');
      await discussion.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '版本历史', exact: true }).click();
      const materialHistory = page.getByRole('dialog', { name: '材料版本历史' }); await materialHistory.waitFor();
      await materialHistory.getByText('材料版本 12 正文', { exact: true }).waitFor();
      assert.equal(await materialHistory.locator('.tm-document-preview').count(), 1);
      assert(await materialHistory.getByRole('button', { name: '上一页', exact: true }).isDisabled());
      await materialHistory.getByRole('button', { name: '下一页', exact: true }).click();
      await materialHistory.getByText('材料版本 11 正文', { exact: true }).waitFor();
      await shot('material-history');
      await materialHistory.getByLabel('选择材料版本').selectOption('v1');
      await materialHistory.getByText('材料版本 1 正文', { exact: true }).waitFor();
      assert(await materialHistory.getByRole('button', { name: '下一页', exact: true }).isDisabled());
      await materialHistory.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.locator('.tm-material-comments-card, .tm-history-card').count(), 0);
      assert(await page.getByLabel('材料正文编辑器').textContent() === '材料版本 12 正文');
      await page.goto(origin+'/app/projects/p/data?resourceType=material&resourceId=mat1&versionId=v6');
      await materialHistory.waitFor();
      await materialHistory.getByText('材料版本 6 正文', { exact: true }).waitFor();
      assert.equal(await materialHistory.getByLabel('选择材料版本').inputValue(), 'v6');
      await page.reload(); await materialHistory.waitFor();
      await materialHistory.getByText('材料版本 6 正文', { exact: true }).waitFor();
      await materialHistory.getByRole('button', { name: '关闭', exact: true }).click();
      report.checks.push(`${width}px ${theme}: top discussion/history buttons, discussion pagination/draft/Escape, one-version snapshot pagination, last-page boundary, immutable editor, version deep-link and reload`);
      await page.goto(origin+'/app/projects/p/data?resourceType=source&resourceId=src1');
      await page.getByRole('heading', { name: '资料原文与处理状态' }).waitFor();
      const sourceCard = page.locator('.resource-source-card');
      assert(await sourceCard.getByRole('heading', { name: source.title, exact: true }).isVisible());
      assert(await sourceCard.getByLabel('修改资料用途').isVisible());
      assert.equal(await page.locator('.resource-detail-panel h3').filter({ hasText: source.title }).count(), 0);
      await shot('source-card'); await fits();
      await page.goto(origin+'/app/settings/system');
      await page.getByRole('heading', { name: '后端能力与限制' }).waitFor();
      assert(await page.getByRole('link', { name: '系统概况' }).isVisible());
      await shot('system-overview'); await fits();
      report.checks.push(`${width}px ${theme}: modal, menu Escape, AI history, one-submission pagination, back/drafts, layout, Markdown download, print invocation, source header, system overview`);
      await context.close();
    }
    await fetch('http://127.0.0.1:8798/__fixture/role/user');
    const page = await browser.newPage(); await page.goto(origin+'/app/settings/system');
    await page.getByRole('heading', { name: '需要系统管理员权限' }).waitFor();
    assert.equal(await page.getByRole('link', { name: '系统概况' }).count(), 0);
    report.checks.push('ordinary account: direct system route blocked and navigation hidden');
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.stack; throw error; }
  finally { writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
}
if (process.argv.includes('--serve')) serve(); else verify().catch(error => { console.error(error); process.exitCode = 1; });
