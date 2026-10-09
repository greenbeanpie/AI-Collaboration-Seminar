import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = process.argv[2] || 'http://127.0.0.1:5197';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
const output = resolve(process.argv[3] || 'output/d1-read-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const report = { fixtureOnly: true, paidCalls: 0, cases: [] };
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const requests = [], errors = [];
    let status = 'missing';
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.route('**/api/v1/**', route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(request.method(), 'GET');
      assert(url.pathname.endsWith('/collaboration/agent-eligibility'));
      const ids = url.searchParams.get('taskIds').split(',');
      assert(ids.length <= 25 && new Set(ids).size === ids.length);
      requests.push({ ids, status });
      return route.fulfill({ json: { data: { items: ids.map(taskId => ({ taskId, eligibility: {
        status, taskRevision: 1, sourceHash: 'fixture', eligible: status === 'ready' ? true : null,
        reason: status === 'ready' ? 'fixture' : null, jobId: null,
      } })) }, requestId: 'fixture' } });
    });
    await page.goto(`${origin}/test-fixtures/d1-eligibility.html`);
    await page.clock.runFor(100);
    await page.waitForFunction(() => document.querySelectorAll('[data-status="missing"]').length === 20);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].ids.length, 20);
    await page.getByRole('button', { name: 'Toggle Dialog', exact: true }).click();
    await page.clock.runFor(100);
    assert.equal(requests.length, 1);
    await page.clock.runFor(9000);
    assert.equal(requests.length, 1);
    status = 'ready';
    await page.clock.runFor(1100);
    await page.waitForFunction(() => document.querySelectorAll('[data-status="ready"]').length === 21);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].ids.length, 20);
    await page.clock.runFor(30000);
    assert.equal(requests.length, 2);
    const screenshot = resolve(output, `eligibility-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.getByRole('button', { name: 'Clear Session', exact: true }).click();
    await page.clock.runFor(30000);
    assert.equal(requests.length, 2);
    assert.deepEqual(errors, []);
    report.cases.push({ width, initialBatchSize: 20, duplicateDialogRequests: 0, missingPollMs: 10000, terminalAndClearedExtraRequests: 0, screenshot, errors });
    await context.close();
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
