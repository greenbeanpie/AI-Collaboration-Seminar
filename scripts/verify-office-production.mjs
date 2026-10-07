import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { officeFixtures } from './office-fixtures.mjs';

assert(process.argv.includes('--production'), 'Pass --production explicitly');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const origin = 'https://greenbp-team-office.hddhp.workers.dev';
// Use --credentials <private-json> when the saved administrator credentials changed.
const credentialOption = process.argv.indexOf('--credentials');
const credentialPath = credentialOption < 0 ? '.local-secrets/admin-credentials.json' : process.argv[credentialOption + 1];
assert(credentialPath, 'Provide a private credential file after --credentials');
const credentialData = JSON.parse(readFileSync(credentialPath, 'utf8'));
const admin = credentialData.accounts?.production || credentialData;
const out = 'output/office-release';
mkdirSync(out, { recursive: true });
const report = { origin, startedAt: new Date().toISOString(), checks: [], errors: [], projectId: null, paidModelCalls: 0 };
let cookie = '', project, browser;
async function api(path, method = 'GET', body) {
  const response = await fetch(origin + '/api/v1' + path, {
    method, headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${value.error?.code || ''}`);
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return value.data;
}
try {
  await api('/auth/sessions', 'POST', { account: admin.username, password: admin.password });
  project = await api('/projects', 'POST', { name: 'Office格式发布验收 · 合成资料', description: '只包含合成文件，验收后归档', aiCollaborationEnabled: false, planningMode: 'manual', assignmentMode: 'manual', evaluationMode: 'manual', progressionMode: 'manual' });
  report.projectId = project.id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  // The capability endpoint is global; disable only its AI flag in this test
  // browser, while keeping every upload/import/download/index request live.
  await context.route('**/api/v1/capabilities', async route => {
    const response = await route.fetch();
    const value = await response.json();
    value.data.features.aiEnabled = false;
    await route.fulfill({ response, json: value });
  });
  report.aiCapabilityDisabledInTestBrowser = true;
  const separator = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin }]);
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.setDefaultTimeout(60000);
  for (const fixture of await officeFixtures()) {
    await page.goto(`${origin}/app/projects/${project.id}/sources`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '文件', exact: true }).click();
    const input = page.locator('input[type=file]').first();
    assert((await input.getAttribute('accept')).includes('.' + fixture.name.split('.').at(-1)));
    await input.setInputFiles({ name: fixture.name, mimeType: 'application/octet-stream', buffer: Buffer.from(fixture.bytes) });
    // Explicitly choose cloud: Office must still use browser extraction.
    await page.getByLabel('正文解析方式', { exact: true }).selectOption('cloud');
    const completed = page.waitForResponse(response => /\/document-imports\/[^/]+\/complete$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '导入来源', exact: true }).click();
    const finishResponse = await completed;
    assert(finishResponse.ok(), `Browser import failed: ${finishResponse.status()}`);
    assert((await finishResponse.json()).data.textReady);
    const sources = await api(`/projects/${project.id}/sources`);
    const source = sources.items.find(item => item.title === fixture.name);
    assert(source, 'Uploaded source not listed');
    const versionId = source.currentVersionId || source.sourceVersionId;
    assert(versionId, 'Missing source version');
    const version = await api(`/projects/${project.id}/sources/${source.sourceId}/versions/${versionId}`);
    const fileId = version.fileId || version.version?.fileId;
    assert(fileId, 'Missing original file');
    const download = await fetch(`${origin}/api/v1/projects/${project.id}/files/${fileId}/content`, { headers: { cookie } });
    assert(download.ok);
    assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'), createHash('sha256').update(fixture.bytes).digest('hex'));
    const index = `/projects/${project.id}/resource-index/source/${versionId}`;
    const directory = await api(index);
    assert(directory.items.length);
    assert(directory.items.every(item => item.pageNumber === null));
    const search = await api(index + '/search?query=' + encodeURIComponent(fixture.expectedText));
    assert(search.items.length, 'Extracted text not searchable');
    const section = await api(index + '/section?sectionId=' + encodeURIComponent(search.items[0].sectionId) + '&neighbors=true');
    assert(section.fragments.some(fragment => fragment.quote.includes(fixture.expectedText)), 'Original quote missing');
    await page.screenshot({ path: `${out}/${fixture.name.split('.').at(-1)}.png`, fullPage: true });
    report.checks.push(`${fixture.name}: production UI upload/browser Worker/private download hash/index/search/original quote`);
  }
  assert.equal(report.errors.length, 0, 'Browser runtime errors');
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  if (project) {
    const current = await api(`/projects/${project.id}`);
    await api(`/projects/${project.id}`, 'PATCH', { expectedRevision: current.revision, status: 'archived' });
    report.checks.push('temporary project archived');
  }
  await browser?.close();
  report.completedAt = new Date().toISOString();
  writeFileSync(`${out}/production-verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
