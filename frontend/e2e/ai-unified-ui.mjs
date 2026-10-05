/* global URL, document, innerWidth, console, process */
// Synthetic local-only browser QA: all API calls mocked, no actual configuration writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('../../../yso-update/frontend/node_modules/playwright');
const base = process.env.WORKBENCH_URL || 'http://127.0.0.1:5187';
assert.equal(new URL(base).hostname, '127.0.0.1');
const output = path.resolve(process.env.QA_OUTPUT || '../../qa'); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
const results = [], errors = [], puts = [], external = [];
const model = { provider: 'openai-compatible', model: 'synthetic-old-model', apiUrl: 'https://fixture.invalid/v1/chat/completions', keyConfigured: true, timeoutMs: 90000, maxInputChars: 48000, supportsJson: true, supportsVision: false, pricePerMTokens: null };
try {
 const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
 const page = await context.newPage(); page.setDefaultTimeout(12000);
 page.on('pageerror', e => errors.push(e.message));
 await context.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host !== '127.0.0.1') { external.push(host); return route.abort(); } return route.continue(); });
 await context.route('**/api/v1/**', async route => {
  const request = route.request(), endpoint = new URL(request.url()).pathname;
  let data = { items: [], nextCursor: null };
  if (endpoint === '/api/v1/auth/session') data = { user: { id: 'unified-qa', username: 'fixture', displayName: 'Synthetic administrator', email: null, role: 'super_admin', isAdmin: true } };
  if (endpoint === '/api/v1/capabilities') data = {};
  if (endpoint === '/api/v1/admin/ai-config') {
   if (request.method() === 'GET') data = { version: 7, enabled: false, config: { textEconomy: model, visionEconomy: model, review: model } };
   else if (request.method() === 'PUT') { puts.push(request.postDataJSON()); data = { version: 8 }; }
   else throw new Error('Unexpected API method');
  } else assert.equal(request.method(), 'GET');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
 });
 await page.goto(`${base}/app/settings/ai`);
 const mode = page.getByLabel('模型路由模式'); await mode.waitFor();
 assert.equal(await mode.inputValue(), 'unified'); assert.equal(await page.locator('.ai-model-settings').count(), 1);
 assert.equal(await page.getByRole('button', { name: /^测试/ }).count(), 2);
 assert.match(await page.getByRole('note').innerText(), /图片 \/ OCR 不可用/);
 results.push('default unified: one model form, text-only notice and two probes');
 await page.getByLabel('统一模型模型名称', { exact: true }).fill('synthetic-unified-draft');
 await mode.selectOption('advanced'); await page.getByLabel('文本与要求提取模型名称', { exact: true }).fill('synthetic-advanced-draft');
 await mode.selectOption('unified'); assert.equal(await page.getByLabel('统一模型模型名称', { exact: true }).inputValue(), 'synthetic-unified-draft');
 await mode.selectOption('advanced'); assert.equal(await page.getByLabel('文本与要求提取模型名称', { exact: true }).inputValue(), 'synthetic-advanced-draft');
 results.push('mode roundtrip preserves both independent non-sensitive drafts');
 await page.getByRole('button', { name: '读取已保存配置' }).click();
 await page.getByText('当前 AI 未启用。', { exact: true }).waitFor();
 assert.equal(await mode.inputValue(), 'advanced'); assert.equal(await page.getByLabel('文本与要求提取模型名称', { exact: true }).inputValue(), 'synthetic-old-model');
 results.push('legacy GET without routingMode renders advanced configuration');
 await mode.selectOption('unified'); assert.equal(await page.getByLabel(/统一模型 API key/).inputValue(), '');
 await page.getByLabel('统一模型模型名称', { exact: true }).fill('synthetic-unified-draft');
 await page.getByRole('button', { name: '保存配置并停用 AI' }).click();
 await page.getByText('配置已保存，AI 暂停启用。请逐项测试。', { exact: true }).waitFor();
 assert.equal(puts.length, 1); assert.equal(puts[0].expectedVersion, 7); assert.equal(puts[0].routingMode, 'unified'); assert.equal(puts[0].textEconomy.model, 'synthetic-old-model'); assert.equal(puts[0].unified.apiKey, '');
 results.push('mock-only PUT sends expectedVersion 7, unified routing and retained advanced draft; no key entered');
 await page.screenshot({ path: path.join(output, 'ai-unified-desktop.png'), fullPage: true });
 await page.setViewportSize({ width: 390, height: 844 });
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 await page.screenshot({ path: path.join(output, 'ai-unified-mobile.png'), fullPage: true });
 results.push('desktop and 390px screenshots; no horizontal overflow');
 assert.deepEqual(errors, []); assert.deepEqual(external, []);
 writeFileSync(path.join(output, 'ai-unified-ui-results.json'), JSON.stringify({ passed: true, checks: results, pageErrors: errors, externalRequests: external, mockedPutCount: puts.length, realBackendCalls: 0, screenshots: ['ai-unified-desktop.png', 'ai-unified-mobile.png'] }, null, 2));
 console.log(JSON.stringify({ passed: true, checks: results }, null, 2));
} finally { await browser.close(); }
