// Loopback fixture: real React app, no production writes, accounts, or model calls.
// --serve starts fixtures + Vite; --baseline captures before; default verifies after.
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:5197';
const now = '2026-10-02T12:00:00Z';
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const task = { taskId: 't1', title: '演示文稿结构与 5 分钟答辩提纲', detail: '按收集数据、分析、演示的主线组织文稿，说明背景、方法、样本来源、结果与限制，所有缺少验证的数据保留待填写标记，提交五分钟的演示结构及讲稿骨架。', criteria: '提交完整演示结构和讲稿骨架，保留所有待验证标记。', effortHours: 3, revision: 7, assigneeId: 'u', lifecycleState: 'improve', currentSubmissionId: 's3', status: 'doing', dependsOnTaskIds: [], unfinishedDependencyIds: [], createdAt: now, updatedAt: now, summary: '组织五分钟演示结构与讲稿骨架，覆盖报告要点，保留待验证数据标记。', summaryStatus: 'succeeded', summaryJobId: null };
const versions = Array.from({ length: 12 }, (_, i) => ({ versionId: `v${12 - i}`, materialId: 'mat1', revision: 12 - i, createdAt: now, origin: 'manual', doc: doc(`材料版本 ${12 - i} 正文`), attachments: [] }));
const material = { materialId: 'mat1', title: '演示结构文档', kind: 'document', purpose: 'output', revision: 12, currentVersionId: 'v12', currentVersion: versions[0], updatedAt: now, createdAt: now };
let comments = [];
function reset() { comments = Array.from({ length: 12 }, (_, i) => ({ commentId: `c${i}`, authorName: '测试成员', authorId: 'u', body: `讨论内容 ${i + 1}`, createdAt: new Date(Date.parse(now) - i * 60000).toISOString(), targetType: 'material', targetId: 'mat1' })); }
reset();
const submissions = [3, 2, 1].map(round => ({ submissionId: `s${round}`, taskId: 't1', round, submittedBy: 'u', body: `第 ${round} 轮成果说明：已提交演示结构与材料，请核验来源。`, materialVersionIds: ['v12'], materialVersions: [{ versionId: 'v12', materialId: 'mat1', title: material.title, revision: 12 }], criteria: `第 ${round} 轮固定验收标准`, status: 'evaluated', aiDecision: null, aiFeedback: null, aiReport: null, decision: 'improve', feedback: `第 ${round} 轮反馈：请补充来源核验。`, revision: 2, evaluationJobId: null, evaluationAttempts: 0, createdAt: now, updatedAt: now }));
function serve() {
  const apiServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:8797');
    const p = url.pathname;
    let data = { items: [], nextCursor: null };
    let body;
    if (req.method === 'POST') { let chunks = ''; for await (const chunk of req) chunks += chunk; body = chunks ? JSON.parse(chunks) : {}; }
    if (p === '/__fixture/reset') reset();
    else if (p === '/api/v1/auth/session') data = { user: { id: 'u', username: 'fixture', displayName: '测试成员', email: null, role: 'user', isAdmin: false } };
    else if (p === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false, webFetch: false }, limits: { maxFileBytes: 20000000, maxPdfPages: 50, listDefaultPageSize: 20, listMaxPageSize: 100 }, competitionTemplate: {} };
    else if (p === '/api/v1/projects/p') data = { projectId: 'p', name: '协作布局验收', description: '固定测试数据，无生产写入', myRole: 'owner', status: 'active', revision: 1, updatedAt: now };
    else if (p.endsWith('/goal')) data = { title: '完成演示', detail: '', revision: 1, graphRevision: 1 };
    else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual', revision: 1 };
    else if (p.endsWith('/tasks')) data = { items: [task, { ...task, taskId: 't2', title: '样本采集（人工已有任务）', detail: '提交3条真实样本记录及来源说明，记录每条采集日期', criteria: '提交3条真实样本记录及来源说明，记录每条采集日期', lifecycleState: 'open', currentSubmissionId: null, assigneeId: null, effortHours: 1, summary: null }], nextCursor: null };
    else if (p.endsWith('/submissions')) data = { items: submissions };
    else if (p.endsWith('/members/me')) data = { userId: 'u', role: 'owner', displayName: '测试成员' };
    else if (p.endsWith('/members')) data = { items: [{ userId: 'u', role: 'owner', displayName: '测试成员', joinedAt: now }], nextCursor: null };
    else if (p.endsWith('/resource-library')) data = { items: [{ resourceType: 'material', resourceId: 'mat1', title: material.title, purpose: 'output', revision: 12, currentVersionId: 'v12', canManage: true, updatedAt: now }], nextCursor: null };
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
  apiServer.listen(8797, '127.0.0.1');
  const vite = spawn(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5197'], { cwd: path.join(root, 'frontend'), env: { ...process.env, AI_OFFICE_API_TARGET: 'http://127.0.0.1:8797' }, stdio: 'inherit' });
  const stop = () => { vite.kill(); apiServer.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
async function verify() {
  const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
  const baseline = process.argv.includes('--baseline');
  const evidence = path.join(root, 'output/compact-workspace', baseline ? 'before' : 'after');
  mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH, headless: true });
  const report = { source: 'Real React app + loopback fixtures + Chromium', baseline, checks: [], errors: [] };
  try {
    for (const width of [1440, 390]) {
      await fetch('http://127.0.0.1:8797/__fixture/reset', { method: 'POST' });
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(`${origin}/app/projects/p/tasks`);
      await page.getByRole('button', { name: '演示文稿结构与 5 分钟答辩提纲', exact: true }).waitFor();
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: path.join(evidence, `tasks-${width}.png`), fullPage: true });
      const card = page.locator('.collab-task').first();
      const cardHeight = (await card.boundingBox()).height;
      if (!baseline) {
        assert.equal(await page.getByRole('heading', { name: '任务工作区', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert(cardHeight < 300, `card height ${cardHeight}`);
      }
      await page.getByRole('button', { name: '演示文稿结构与 5 分钟答辩提纲', exact: true }).click();
      await page.getByLabel('成果说明', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(evidence, `task-detail-${width}.png`), fullPage: true });
      if (!baseline) {
        await page.getByLabel('成果说明', { exact: true }).fill('本轮未提交草稿必须保留');
        await page.getByRole('button', { name: '任务设置', exact: true }).click();
        await page.getByText('前置依赖', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(evidence, `task-settings-${width}.png`), fullPage: true });
        await page.getByRole('button', { name: '提交和查看', exact: true }).click();
        assert.equal(await page.getByLabel('成果说明', { exact: true }).inputValue(), '本轮未提交草稿必须保留');
        await page.getByRole('button', { name: /历史记录/ }).click();
        await page.locator('.collab-history').filter({ visible: true }).first().waitFor();
        assert.equal(await page.locator('.collab-history:visible').count(), 1);
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await page.getByText('第 2 轮成果说明：已提交演示结构与材料，请核验来源。', { exact: true }).waitFor();
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        await page.getByText('第 1 轮成果说明：已提交演示结构与材料，请核验来源。', { exact: true }).waitFor();
        assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
        await page.screenshot({ path: path.join(evidence, `task-history-${width}.png`), fullPage: true });
        await page.getByRole('button', { name: '提交和查看', exact: true }).click();
        assert.equal(await page.getByLabel('成果说明', { exact: true }).inputValue(), '本轮未提交草稿必须保留');
        assert.equal(await page.getByText('第 3 轮成果说明：已提交演示结构与材料，请核验来源。', { exact: true }).isVisible(), false);
      }
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.goto(`${origin}/app/projects/p/data?resourceType=material&resourceId=mat1`);
      await page.getByLabel('材料正文编辑器').waitFor();
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await page.screenshot({ path: path.join(evidence, `material-${width}.png`), fullPage: true });
      if (!baseline) {
        assert.equal(await page.getByRole('heading', { name: '项目资料', exact: true }).count(), 0);
        assert.equal(await page.getByRole('heading', { name: 'AI 协助成果', exact: true }).count(), 0);
        assert.equal(await page.getByLabel('发表评论').isVisible(), false);
        // Native details summaries remain keyboard operable.
        await page.getByText('讨论', { exact: true }).click();
        assert.equal(await page.locator('.tm-comment:visible').count(), 5);
        const discussion = page.locator('.tm-comments');
        await discussion.getByRole('button', { name: '下一页', exact: true }).click();
        assert.equal(await page.locator('.tm-comment:visible').count(), 5);
        await discussion.getByRole('button', { name: '下一页', exact: true }).click();
        assert.equal(await page.locator('.tm-comment:visible').count(), 2);
        await page.getByLabel('发表评论').fill('新增讨论验收');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.getByText('新增讨论验收', { exact: true }).waitFor();
        await page.getByText('版本历史', { exact: true }).click();
        assert.equal(await page.locator('.tm-history-item:visible').count(), 5);
        const history = page.locator('.tm-history-card');
        await history.getByRole('button', { name: '下一页', exact: true }).click();
        assert.equal(await page.locator('.tm-history-item:visible').count(), 5);
        await history.getByRole('button', { name: '下一页', exact: true }).click();
        assert.equal(await page.locator('.tm-history-item:visible').count(), 2);
        await page.screenshot({ path: path.join(evidence, `material-expanded-${width}.png`), fullPage: true });
        const inset = await page.evaluate(() => { const a = document.querySelector('[aria-label="材料附件"]'); const e = document.querySelector('.tm-editor-content'); return { a: a.getBoundingClientRect().left, padding: parseFloat(getComputedStyle(a).paddingLeft), e: e.getBoundingClientRect().left }; });
        assert(inset.padding >= 16, JSON.stringify(inset));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.goto(`${origin}/app/projects/p/data?resourceType=material&resourceId=mat1&versionId=v1`);
        await page.getByText('材料版本 1 正文', { exact: true }).waitFor();
        assert(await page.locator('.tm-history-detail').isVisible());
      }
      report.checks.push({ width, cardHeight, result: 'PASS' });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    report.result = 'PASS';
    writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
if (process.argv.includes('--serve')) serve(); else verify().catch(error => { console.error(error); process.exitCode = 1; });
