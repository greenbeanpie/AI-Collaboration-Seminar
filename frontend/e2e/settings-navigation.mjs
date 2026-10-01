/* global process, URL, history, document, innerWidth, console */
// Local-only synthetic accounts; rejects all API writes and external network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '../../../yso-update/frontend/node_modules/playwright');
const base = process.env.WORKBENCH_URL || 'http://127.0.0.1:5175';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = path.resolve(process.env.QA_OUTPUT || '../qa');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
const results = [];
try {
 for (const role of ['user', 'admin', 'super_admin']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const adminReads = [], errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.route('**/api/v1/**', async route => {
   const request = route.request(), endpoint = new URL(request.url()).pathname;
   if (request.method() !== 'GET') { writes.push(endpoint); await route.abort(); return; }
   if (endpoint.includes('/admin/')) adminReads.push(endpoint);
   let data = { items: [], nextCursor: null };
   if (endpoint === '/api/v1/auth/session') data = { user: { id: `fixture-${role}`, username: 'fixture', displayName: 'Synthetic user', email: null, role, isAdmin: role !== 'user' } };
   if (endpoint === '/api/v1/capabilities') data = {};
   await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'qa-fixture' }) });
  });
  await page.goto(`${base}/app/settings/profile`);
  const tabs = page.getByRole('navigation', { name: '设置分类' }); await tabs.waitFor();
  assert.equal(await tabs.getByRole('link', { name: '账户管理', exact: true }).count(), role === 'user' ? 0 : 1);
  assert.equal(await tabs.getByRole('link', { name: 'AI 配置', exact: true }).count(), role === 'super_admin' ? 1 : 0);
  const name = page.locator('input[autocomplete="nickname"]'); await name.fill('Unsaved fixture');
  let unexpectedDialog = false;
  const rejectUnexpected = async dialog => { unexpectedDialog = true; await dialog.dismiss(); };
  page.on('dialog', rejectUnexpected);
  await page.locator('#bell').click(); await page.locator('#history').waitFor({ state: 'visible' });
  await page.evaluate(() => history.back()); await page.locator('#history').waitFor({ state: 'hidden' });
  assert.equal(unexpectedDialog, false, 'Back from notification center must not discard prompt');
  assert.match(page.url(), /\/settings\/profile$/); assert.equal(await name.inputValue(), 'Unsaved fixture');
  page.off('dialog', rejectUnexpected);
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '退出登录' }).click();
  assert.deepEqual(writes, []); assert.equal(await name.inputValue(), 'Unsaved fixture');
  page.once('dialog', dialog => dialog.dismiss()); await tabs.getByRole('link', { name: '账户安全' }).click();
  assert.match(page.url(), /\/settings\/profile$/); assert.equal(await name.inputValue(), 'Unsaved fixture');
  page.once('dialog', dialog => dialog.accept()); await tabs.getByRole('link', { name: '账户安全' }).click(); await page.waitForURL('**/settings/security');
  await page.goBack(); await page.waitForURL('**/settings/profile'); await page.goForward(); await page.waitForURL('**/settings/security');
  await tabs.getByRole('link', { name: '个人资料' }).click(); await name.fill('Retained after Back');
  page.once('dialog', dialog => dialog.dismiss()); await page.evaluate(() => history.back()); await page.waitForTimeout(200);
  assert.match(page.url(), /\/settings\/profile$/); assert.equal(await name.inputValue(), 'Retained after Back');
  await page.screenshot({ path: path.join(output, `ai-settings-${role}-desktop.png`), fullPage: true });
  page.once('dialog', dialog => dialog.accept()); await tabs.getByRole('link', { name: '外观', exact: true }).click(); await page.waitForURL('**/settings/appearance');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile horizontal overflow');
  await page.screenshot({ path: path.join(output, `ai-settings-${role}-mobile.png`), fullPage: true });
  await page.goto(`${base}/app/settings/ai`); await tabs.waitFor();
  if (role !== 'super_admin') { await page.getByRole('alert').waitFor(); assert(!adminReads.some(p => p.includes('ai-config'))); }
  else await page.locator('.ai-model-settings').first().waitFor();
  await page.goto(`${base}/app/admin/accounts`); await page.waitForURL('**/app/settings/accounts');
  if (role === 'user') { await page.getByRole('alert').waitFor(); assert.deepEqual(adminReads, []); }
  else { await page.waitForResponse(r => r.url().includes('/api/v1/admin/accounts')); }
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  results.push({ role, passed: true, checks: ['permission tabs', 'direct URL guard', 'legacy redirect', 'draft cancel', 'logout cancel prevents API write', 'notification center Back preserves draft', 'Back/Forward', '390px layout', 'no API writes', 'no page errors'], adminReads });
  console.log(`PASS ${role}: settings navigation, permissions, draft cancel, history, mobile`); await context.close();
 }
 writeFileSync(path.join(output, 'ai-settings-results.json'), JSON.stringify(results, null, 2));
} finally { await browser.close(); }
