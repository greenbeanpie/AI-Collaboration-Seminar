/** Built UI acceptance with deterministic local API fixtures; does not invoke a real model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/hddhp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = process.argv[2] || 'http://127.0.0.1:4173';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = resolve('output/project-chat/browser');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const projectId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const now = '2026-10-07T00:00:05Z';
const report = { fixtureOnly: true, realModelInvoked: false, checks: [], screenshots: [], errors: [], operationRequests: [] };
let activePage;
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme: width === 390 ? 'dark' : 'light', serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    let items = [], status = 'succeeded', jobId = 'initial-job', sends = 0, resumes = 0, clears = 0;
    let pollsAfterResume = 0, failNextSend = false;
    const question = () => ({ id: 'user-message', questionId: 'question-1', role: 'user', content: '项目截止日期是什么？', createdAt: now, jobId });
    const resourceHref = `/app/projects/${projectId}/data?resourceType=source&resourceId=notice&sourceVersionId=notice-version&page=3#source-page-notice-3`;
    const answer = () => ({ id: 'assistant-message', questionId: 'question-1', role: 'assistant', content: '根据项目通知，截止日期为 **2026-10-18**。', createdAt: now, jobId, references: [{ title: '项目通知 · 第 3 页', href: resourceHref }] });
    const operation = (id, kind, label, attempt = 1) => ({ id, kind, label, status: 'completed', at: now, attempt, href: kind === 'read' ? resourceHref : null });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (url.origin !== new URL(origin).origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      let data = { items: [], nextCursor: null }, responseStatus = 200;
      if (path.endsWith('/auth/session')) data = { user: { id: userId, username: 'fixture', displayName: '测试成员', role: 'user', isAdmin: false } };
      else if (path.endsWith('/capabilities')) data = { features: { aiEnabled: true }, limits: { maxFileBytes: 20000000 }, competitionTemplate: {} };
      else if (path === `/api/v1/projects/${projectId}`) data = { projectId, name: '项目问答验收', description: '本地固定数据', status: 'active', myRole: 'owner', revision: 1, deadlineDate: '2026-10-18', deadlinePrecision: 'day' };
      else if (path.endsWith('/members/me')) data = { userId, displayName: '测试成员', role: 'owner' };
      else if (path.endsWith('/goal')) data = { title: '交付可核对的调研报告', detail: '报告须引用项目资料。', revision: 1, graphRevision: 1 };
      else if (path.endsWith('/tasks/graph')) data = { items: [], graphRevision: 1, canRegenerate: false, totals: { total: 0, done: 0 } };
      else if (path.endsWith('/collaboration/settings')) data = { aiCollaborationEnabled: true, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 };
      else if (path.endsWith('/ai-chat')) {
        if (method === 'POST') {
          if (failNextSend) { failNextSend = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AI_UNAVAILABLE', message: '模拟模型不可用', retryable: true }, requestId: 'fixture' }) }); }
          sends++; jobId = 'failed-job'; status = 'failed'; items = [question()]; data = { questionId: 'question-1', jobId }; responseStatus = 202;
        } else if (method === 'DELETE') { clears++; items = []; data = { cleared: true }; }
        else data = { items, nextCursor: null, pendingJobId: ['queued', 'running'].includes(status) ? jobId : null };
      } else if (path.endsWith('/operations')) {
        const more = url.searchParams.get('cursor');
        report.operationRequests.push({ width, cursor: more });
        data = more ? { items: [operation('op3', 'read', '已读取项目主目标', resumes ? 2 : 1)], nextCursor: null }
          : { items: [operation('op1', 'search', '已搜索“截止日期”'), operation('op2', 'read', '已读取《项目通知》· 第 3 页')], nextCursor: 'more' };
      } else if (path.startsWith('/api/v1/jobs/')) {
        if (method === 'POST') { resumes++; jobId = 'resumed-job'; status = 'running'; pollsAfterResume = 0; data = { jobId }; responseStatus = 202; }
        else {
          if (status === 'running' && ++pollsAfterResume >= 2) { status = 'succeeded'; items = [question(), answer()]; }
          data = { jobId, kind: 'agent_run', status, result: null, error: status === 'failed' ? { code: 'AI_UNAVAILABLE', message: '模拟生成中断' } : null, attempts: 1, createdAt: now, updatedAt: now, finishedAt: status === 'succeeded' ? now : null, activity: { code: status === 'succeeded' ? 'completed' : 'calling_model', updatedAt: now, lastResponseAt: now, progress: null, canResume: status === 'failed', resumeReason: null, uncertain: status === 'failed' } };
        }
      }
      return route.fulfill({ status: responseStatus, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'fixture' }) });
    });
    await page.goto(`${origin}/app/projects/${projectId}`);
    const card = page.locator('.project-ai-chat');
    await card.getByLabel('向 AI 提问').waitFor();
    const goal = await page.getByText('交付可核对的调研报告', { exact: true }).boundingBox();
    const box = await card.boundingBox();
    assert(box.y > goal.y, 'chat must be below goal');
    assert.equal(await card.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
    failNextSend = true;
    await card.getByLabel('向 AI 提问').fill('项目截止日期是什么？');
    await card.getByRole('button', { name: '发送', exact: true }).click();
    await card.getByText('模拟模型不可用', { exact: false }).waitFor();
    assert.equal(await card.getByLabel('向 AI 提问').inputValue(), '项目截止日期是什么？');
    await card.getByRole('button', { name: '发送', exact: true }).click();
    await card.getByRole('button', { name: '从停止处继续', exact: true }).waitFor();
    assert.equal(sends, 1);
    await card.getByText('已搜索“截止日期”', { exact: true }).waitFor();
    assert.match(await card.getByRole('link', { name: '已读取《项目通知》· 第 3 页' }).getAttribute('href'), /resourceType=source/);
    await card.getByRole('button', { name: '加载更多操作' }).click();
    await card.getByText('已读取项目主目标', { exact: true }).waitFor();
    await page.reload();
    await card.getByRole('button', { name: '从停止处继续', exact: true }).waitFor();
    await card.getByRole('button', { name: '从停止处继续', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `failed-${width}.png`), fullPage: true });
    await card.getByRole('button', { name: '从停止处继续', exact: true }).click();
    await card.getByText('2026-10-18', { exact: true }).waitFor();
    assert.equal(resumes, 1); assert.equal(sends, 1, 'resume must not submit another question');
    assert.equal(await card.locator('.project-chat-operations').getAttribute('open'), null);
    await card.locator('summary').click();
    await card.getByRole('link', { name: '项目通知 · 第 3 页', exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, `completed-${width}.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal page overflow');
    await page.reload();
    await card.getByText('2026-10-18', { exact: true }).waitFor();
    await card.getByRole('button', { name: '清空历史记录', exact: true }).click();
    await card.getByText('可以询问项目目标、任务进度或资料中的要求。', { exact: true }).waitFor();
    assert.equal(clears, 1);
    report.checks.push({ width, theme: width === 390 ? 'dark' : 'light', placement: true, failurePreservesInput: true, operationsAndPagination: true, refreshRecovery: true, checkpointResumeUi: true, clearHistory: true, noOverflow: true });
    report.screenshots.push(`failed-${width}.png`, `completed-${width}.png`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
    await writeFile(resolve(output, 'failure.txt'), await activePage.locator('body').innerText());
  }
  throw error;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
