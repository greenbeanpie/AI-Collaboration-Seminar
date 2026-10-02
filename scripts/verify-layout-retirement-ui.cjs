// Loopback fixture: real React app, no production writes, accounts, or model calls.
// --serve starts fixtures + Vite; default verifies responsive layout and retirement.
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
    if (p === '/__fixture/reset') reset();
    else if (p === '/api/v1/auth/session') data = { user: { id: 'u', username: 'fixture', displayName: '测试成员', email: null, role: 'user', isAdmin: false } };
    else if (p === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false, webFetch: false, emailMode: 'disabled' }, limits: { maxFileBytes: 20000000, maxPdfPages: 50, pageImageMaxEdge: 2000, pageImageMaxBytes: 1000000, concurrentAiTasksPerProject: 2, listDefaultPageSize: 20, listMaxPageSize: 100 }, competitionTemplate: {} };
    else if (p === '/api/v1/projects/p') data = { projectId: 'p', name: '协作布局验收', description: '固定测试数据，无生产写入', myRole: 'owner', status: 'active', deadlineDate: null, deadlinePrecision: 'unknown', revision: 1, updatedAt: now };
    else if (p.endsWith('/goal')) data = { title: '完成演示', detail: '', revision: 1, graphRevision: 1 };
    else if (p.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual', revision: 1 };
    else if (p.endsWith('/tasks')) data = { items: Array.from({length: 5}, (_, i) => ({ ...task, taskId: `t${i+1}`, title: i ? '样本数据整理与分析任务 '+i+' 较长的标题用于检查换行' : task.title, lifecycleState: i ? 'open' : 'improve', assigneeId: i ? null : 'u', currentSubmissionId: i ? null : 's3', effortHours: i+1, dependsOnTaskIds: i ? ['t1'] : [], unfinishedDependencyIds: i ? ['t1'] : [], summary: i === 4 ? null : task.summary })), nextCursor: null };
    else if (p.endsWith('/submissions')) data = { items: submissions };
    else if (p.endsWith('/members/me')) data = { userId: 'u', role: 'owner', displayName: '测试成员' };
    else if (p.endsWith('/members')) data = { items: Array.from({length:4}, (_, i) => ({ memberId: 'm'+i, userId: i ? 'u'+i : 'u', role: i ? 'member' : 'owner', displayName: '测试成员'+i, email: 'fixture'+i+'@invalid.test', joinedAt: now })), nextCursor: null };
    else if (p.endsWith('/events')) data = { items: Array.from({length: 12}, (_,i) => ({ eventId: 'e'+i, type: 'task.claimed', actorType: 'user', actorId: 'u', entityType: 'task', entityId: 't1', payload: {}, occurredAt: now })).slice(Number(url.searchParams.get('cursor') || 0), Number(url.searchParams.get('cursor') || 0)+Number(url.searchParams.get('limit') || 10)), nextCursor: url.searchParams.get('cursor') ? null : '10' };
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
    res.end(JSON.stringify({ data, requestId: 'layout-retirement-fixture' }));
  });
  apiServer.listen(8798, '127.0.0.1');
  const vite = spawn(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5198'], { cwd: path.join(root, 'frontend'), env: { ...process.env, AI_OFFICE_API_TARGET: 'http://127.0.0.1:8798' }, stdio: 'inherit' });
  const stop = () => { vite.kill(); apiServer.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
async function verify() {
  const { chromium } = require(process.env.UI_PLAYWRIGHT_PATH || 'playwright');
  const evidence = path.join(root, 'output/layout-retirement-ui');
  mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM_PATH, headless: true });
  const report = { result: 'RUNNING', errors: [], checks: [], boundary: 'Real React app with loopback API fixtures; backend mutations verified separately.' };
  try {
    for (const width of [1440, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on('pageerror', error => report.errors.push(error.message));
      const removedCalls = [];
      page.on('request', request => { if (/\/(decisions|contributions|resources)(?:[/?]|$)/.test(new URL(request.url()).pathname)) removedCalls.push(request.url()); });
      await page.goto('http://127.0.0.1:5198/app/projects/p/tasks');
      await page.getByRole('button', {name: task.title, exact: true}).waitFor();
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      const heights = await page.locator('.collab-task').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      assert.equal(heights.length, 5);
      assert.equal(await page.locator('.collab-task > p.notice').count(), 0);
      const warning = page.locator('.collab-dependency-warning').first();
      await warning.focus();
      assert(await warning.getByRole('tooltip').isVisible());
      await page.getByLabel('筛选', {exact:true}).focus();
      assert(Math.max(...heights)-Math.min(...heights) < 1, 'Unequal cards '+JSON.stringify(heights));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByLabel('筛选', {exact: true}).count(), 1);
      const toolbar = await page.locator('.collab-toolbar-actions').evaluate(node => { const [ai, create] = node.querySelectorAll('button'); const a=ai.getBoundingClientRect(), b=create.getBoundingClientRect(); return {aiLeft:a.left, createLeft:b.left, aiTop:a.top, createTop:b.top}; });
      assert(toolbar.aiLeft < toolbar.createLeft && Math.abs(toolbar.aiTop-toolbar.createTop)<1, JSON.stringify({width,toolbar}));
      const footers = await page.locator('.collab-task-footer').evaluateAll(nodes=>nodes.map(node=>node.parentElement.getBoundingClientRect().bottom-node.getBoundingClientRect().bottom));
      assert(Math.max(...footers)-Math.min(...footers)<1);

      const ai = page.getByRole('button', {name: 'AI 拆解、调整与分工', exact:true});
      assert(await ai.isVisible());
      await ai.press('Enter');
      await page.getByLabel('目标、补充信息或调整要求').waitFor();
      await page.getByLabel('目标、补充信息或调整要求').fill('保留AI草稿');
      await ai.press('Enter'); await ai.press('Enter');
      assert.equal(await page.getByLabel('目标、补充信息或调整要求').inputValue(), '保留AI草稿');
      await ai.click();
      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path: path.join(evidence, `tasks-${width}.png`), fullPage:true});
      await page.getByRole('button', {name: task.title, exact:true}).click();
      await page.getByLabel('成果说明', {exact:true}).waitFor();
      await page.getByLabel('成果说明', {exact:true}).fill('保留未提交草稿');
      await page.getByRole('tab', {name:'任务设置', exact:true}).press('Enter');
      await page.getByRole('heading', {name:'任务介绍', exact:true}).waitFor();
      assert.equal(await page.getByText(/^执行人：/).count(),0);
      await page.getByRole('button', {name:'调整前置任务',exact:true}).press('Enter');
      await page.getByRole('group', {name:'选择前置任务'}).waitFor();
      const dependency = await page.locator('.collab-dependency-heading').evaluate(node => { const a=node.querySelector('button').getBoundingClientRect(), b=node.querySelector('h3').getBoundingClientRect(); return {editLeft:a.left,headingLeft:b.left}; });
      assert(dependency.editLeft < dependency.headingLeft);

      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path:path.join(evidence, `detail-${width}.png`),fullPage:true});
      await page.getByRole('tab', {name:'提交和查看',exact:true}).press('Enter');
      await page.locator('.collab-submit textarea').waitFor();
      assert.equal(await page.locator('.collab-submit textarea').inputValue(),'保留未提交草稿');
      await page.getByRole('button',{name:'关闭',exact:true}).click();
      await page.getByLabel('筛选',{exact:true}).selectOption('open');
      assert.equal(await page.locator('.collab-task').count(),4);
      await page.goto('http://127.0.0.1:5198/app/projects/p/settings');
      await page.getByRole('heading',{name:'AI 智能协作',exact:true}).waitFor();
      await page.getByRole('heading',{name:'后端能力与限制',exact:true}).waitFor();
      const settingsColumns=await page.locator('.compact-settings-grid').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length);
      assert.equal(settingsColumns,width>=1100?2:1);

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path:path.join(evidence,`settings-${width}.png`),fullPage:true});
      await page.goto('http://127.0.0.1:5198/app/projects/p/team');
      await page.getByRole('heading',{name:'成员与任务负荷',exact:true}).waitFor();
      await page.locator('.team-member').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path:path.join(evidence,`team-${width}.png`),fullPage:true});
      await page.goto('http://127.0.0.1:5198/app/projects/p/ledger');
      await page.getByText('本页 10 条',{exact:true}).waitFor();
      for(const name of ['过程账本','决策记录','贡献记录','第三方资源声明']) assert.equal(await page.getByRole('heading',{name,exact:true}).count(),0);
      await page.getByRole('button',{name:'下一页',exact:true}).click();
      await page.getByText('本页 2 条',{exact:true}).waitFor();
      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      await page.screenshot({path:path.join(evidence,`events-${width}.png`),fullPage:true});
      assert.deepEqual(removedCalls,[]);
      report.checks.push({width,cardHeights:heights,footerInsets:footers,toolbar,settingsColumns,result:'PASS',retiredRequests:removedCalls.length});
      await page.close();
    }
    assert.deepEqual(report.errors,[]);
    report.result='PASS';
    writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } finally { await browser.close(); }
}
if (process.argv.includes('--serve')) serve(); else verify().catch(error => {console.error(error);process.exitCode=1;});
