// Local UI fixture only: no real accounts, database writes, or model calls.
// Requires frontend dependencies, agent-browser and an installed Chromium.
// Set UI_AGENT_BROWSER_PATH to the agent-browser executable when it is not on PATH.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'output', 'project-page-pagination');
const origin = 'http://127.0.0.1:5199';
const apiOrigin = 'http://127.0.0.1:8799';
const now = '2026-10-02T12:00:00Z';
const eventRequests = [];
let events = Array.from({ length: 22 }, (_, index) => ({ eventId: `e-${index}`, type: 'decision.recorded', actorType: 'user', actorId: 'u', entityType: 'decision', entityId: `d-${index}`, payload: { title: `历史事件 ${index + 1}` }, occurredAt: new Date(Date.parse(now) - index * 60000).toISOString() }));
const apiServer = createServer((req, res) => {
  const url = new URL(req.url, apiOrigin);
  const endpoint = url.pathname;
  let data = { items: [], nextCursor: null };
  if (endpoint === '/api/v1/auth/session') data = { user: { id: 'u', username: 'fixture', displayName: '本地测试成员', email: null, role: 'super_admin', isAdmin: true } };
  else if (endpoint === '/api/v1/capabilities') data = { environment: 'local', apiVersion: 'v1', features: { aiEnabled: false, webFetch: false }, limits: { maxFileBytes: 20000000, maxPdfPages: 50, pageImageMaxEdge: 1600, pageImageMaxBytes: 1000000, listDefaultPageSize: 20, listMaxPageSize: 100 }, competitionTemplate: {} };
  else if (endpoint === '/api/v1/projects/p') data = { projectId: 'p', name: '项目页面精简验收', description: '本地固定数据验证', myRole: 'owner', status: 'active', revision: 1, deadlineDate: '2026-10-18', deadlinePrecision: 'date', updatedAt: now };
  else if (endpoint.endsWith('/goal')) data = { title: '概览保留的项目目标', detail: '底层目标仍存在', revision: 1 };
  else if (endpoint.endsWith('/collaboration/settings')) data = { revision: 1, aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', planningMode: 'manual', progressionMode: 'manual' };
  else if (endpoint.endsWith('/members/me')) data = { userId: 'u', role: 'owner', displayName: '本地测试成员' };
  else if (endpoint.endsWith('/members')) data = { items: [{ userId: 'u', role: 'owner', displayName: '本地测试成员', joinedAt: now, weeklyHours: 10 }], nextCursor: null };
  else if (endpoint.endsWith('/username-invitations')) data = { items: [], nextOffset: null };
  else if (endpoint.endsWith('/events')) {
    const start = Number(url.searchParams.get('cursor') || 0);
    const limit = Number(url.searchParams.get('limit') || 10);
    eventRequests.push({ cursor: url.searchParams.get('cursor'), limit });
    data = { items: events.slice(start, start + limit), nextCursor: start + limit < events.length ? String(start + limit) : null };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data, requestId: 'project-pages-ui-fixture' }));
});
const browserArgs = ['--session', 'project-pages-verification'];
if (process.env.UI_CHROMIUM_PATH) browserArgs.push('--executable-path', process.env.UI_CHROMIUM_PATH);
async function browser(...args) {
  const { stdout } = await run(process.env.UI_AGENT_BROWSER_PATH || 'agent-browser', [...browserArgs, ...args], { timeout: 45000, maxBuffer: 2000000 });
  return stdout.trim();
}
async function evaluate(expression) {
  const value = JSON.parse(await browser('eval', expression));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function waitFor(expression) { await browser('wait', '--fn', expression); }
async function navigate(route) {
  await browser('open', origin + '/app/projects/p' + route);
  await waitFor("document.querySelector('[data-testid=project-tabs]') && !document.querySelector('.loading')");
}
const report = { source: 'Local API fixture; real React app and Chromium', checks: [], eventRequests };
async function checkPage(route, name, width) {
  await navigate(route);
  const state = await evaluate(`JSON.stringify({ overflow: document.documentElement.scrollWidth > innerWidth, headings: [...document.querySelectorAll('.project-section-heading')].length, tabs: [...document.querySelectorAll('[data-testid=project-tabs] a')].map(a=>a.textContent), singleton: ${['/tasks', '/data', '/assessment'].includes(route)} && !!document.querySelector('.project-section-navigation'), errors: document.querySelectorAll('[role=alert], vite-error-overlay').length })`);
  assert.equal(state.overflow, false, `${name} overflow at ${width}`);
  assert.equal(state.headings, 0);
  assert.equal(state.singleton, false);
  assert.equal(state.errors, 0, `${name} errors`);
  assert.deepEqual(state.tabs, ['概览', '任务', '资料', '评分', '团队']);
  const removed = await evaluate(`JSON.stringify({ modules: !!document.querySelector('.module-links'), footer: !!document.querySelector('.overview-footer-note'), recent: [...document.querySelectorAll('h2')].some(h=>h.textContent==='最近活动'), taskGoal: location.pathname.endsWith('/tasks') && [...document.querySelectorAll('h2')].some(h=>h.textContent==='项目主目标'), teamShortcuts: [...document.querySelectorAll('a')].some(a=>['打开团队设置','打开项目导出','打开我的个人资料','打开任务工作区'].includes(a.textContent)), aiSettings: [...document.querySelectorAll('h2')].some(h=>h.textContent==='AI 模型接入与测试') })`);
  Object.entries(removed).forEach(([key, value]) => assert.equal(value, false, `${name}: ${key}`));
  await browser('screenshot', path.join(evidence, `${name}-${width}.png`), '--full');
  report.checks.push({ page: name, width, ...state, removed });
}
(async () => {
  mkdirSync(evidence, { recursive: true });
  await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(8799, '127.0.0.1', resolve); });
  const vite = spawn(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5199'], { cwd: path.join(root, 'frontend'), env: { ...process.env, AI_OFFICE_API_TARGET: apiOrigin }, windowsHide: true, stdio: 'pipe' });
  let logs = '';
  vite.stdout.on('data', chunk => { logs += chunk; });
  vite.stderr.on('data', chunk => { logs += chunk; });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (vite.exitCode !== null) throw new Error(logs);
      if (await fetch(origin).then(r => r.ok).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    for (const width of [1440, 390]) {
      await browser('set', 'viewport', String(width), '1000');
      for (const [route, name] of [['', 'overview'], ['/tasks', 'tasks'], ['/data', 'data'], ['/assessment', 'assessment'], ['/team', 'team'], ['/settings', 'settings']]) await checkPage(route, name, width);
      await navigate('/ledger');
      await waitFor("document.querySelectorAll('.ledger-line').length===10");
      const collected = [];
      for (const [index, count] of [[1, 10], [2, 10], [3, 2]]) {
        await waitFor(`document.querySelectorAll('.ledger-line').length===${count} && document.querySelector('.ledger-pagination').textContent.includes('第 ${index} 页')`);
        collected.push(...await evaluate("JSON.stringify([...document.querySelectorAll('.ledger-content p')].map(p=>p.textContent))"));
        await browser('screenshot', path.join(evidence, `ledger-${width}-page-${index}.png`), '--full');
        if (index < 3) await browser('find', 'role', 'button', 'click', '--name', '下一页');
      }
      assert.equal(new Set(collected).size, 22);
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      assert.equal(await evaluate("[...document.querySelectorAll('.ledger-pagination button')].find(b=>b.textContent==='下一页').disabled"), true);
      await browser('find', 'role', 'button', 'click', '--name', '上一页');
      await waitFor("document.querySelector('.ledger-pagination').textContent.includes('第 2 页') && document.querySelectorAll('.ledger-line').length===10");
      await browser('select', '[aria-label="每页条数"]', '20');
      await waitFor("document.querySelectorAll('.ledger-line').length===20 && document.querySelector('.ledger-pagination').textContent.includes('第 1 页')");
      await browser('select', '[aria-label="每页条数"]', '50');
      await waitFor("document.querySelectorAll('.ledger-line').length===22");
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
      assert.equal(await evaluate("document.querySelectorAll('[role=alert]').length"), 0);
      report.checks.push({ page: 'ledger', width, counts: [10, 10, 2], uniqueEvents: 22, previousPage: 'passed', pageSizes: [10, 20, 50], overflow: false });
    }
    const errors = await browser('errors');
    assert(!errors || /No (?:page |browser )?errors/i.test(errors), errors);
    report.browserErrors = errors || 'none';
    report.result = 'PASS';
    writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, checks: report.checks.length, evidence }, null, 2));
  } finally {
    await browser('close').catch(() => {});
    vite.kill();
    apiServer.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; apiServer.close(); });
