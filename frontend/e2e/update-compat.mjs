/* global console, URL, window, document, navigator, caches, Response, Buffer, Event, CustomEvent */
// Real generated SW and versioned module graphs; synthetic local-only accounts and native install event.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const require = createRequire(import.meta.url);
const { chromium } = require('../../../yso-update/frontend/node_modules/playwright');
const dist = path.resolve('dist');
const baseline = path.resolve('../../qa/ai-c3-baseline/frontend/dist');
const output = path.resolve('../../qa/update-compat'); mkdirSync(output, { recursive: true });
const latestAssets = readdirSync(path.join(dist, 'assets'));
const rename = value => latestAssets.reduce((text, name) => text.split(name).join('release2-' + name), value);
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
const results = [];
async function run(name, oldDist, evict = false) {
 let version = 1; const writes = [], errors = [], missing = [];
 const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
   if (req.method !== 'GET') { writes.push(url.pathname); res.writeHead(405); return res.end(); }
   const data = url.pathname.endsWith('/auth/session') ? { user: { id: 'synthetic', username: 'fixture', displayName: 'Synthetic user', role: 'super_admin', isAdmin: true, email: null } } : url.pathname.endsWith('/capabilities') ? {} : { items: [], nextCursor: null };
   res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data, requestId: 'local-compat' }));
  }
  let file = decodeURIComponent(url.pathname).replace(/^\//, '');
  if (!file || !path.extname(file)) file = 'index.html';
  if (version === 2 && file.startsWith('assets/') && !file.startsWith('assets/release2-')) { missing.push(file); res.writeHead(404); return res.end(); }
  if (version === 2) file = file.replace('assets/release2-', 'assets/');
  const dir = version === 1 ? oldDist : dist, target = path.resolve(dir, file);
  if (!target.startsWith(dir + path.sep)) { res.writeHead(400); return res.end(); }
  let bytes; try { bytes = readFileSync(target); } catch { res.writeHead(404); return res.end(); }
  if (version === 2 && /\.(js|css|html)$/.test(file)) bytes = Buffer.from(rename(bytes.toString()));
  if (file === 'sw.js') bytes = Buffer.from(bytes.toString().replace(/(url:"index.html",revision:")[^"]+/, '$1compat-' + version) + '\n// compat release ' + version);
  res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store'); res.end(bytes);
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = `http://127.0.0.1:${server.address().port}`;
 const context = await browser.newContext();
 await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
 try {
  const a = await context.newPage(), b = await context.newPage(); a.setDefaultTimeout(18000); b.setDefaultTimeout(18000);
  b.on('pageerror', e => errors.push(e.message));
  await a.goto(origin + '/app/settings/profile'); await a.locator('input[autocomplete="nickname"]').waitFor();
  await a.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)); await a.reload();
  await b.goto(origin + '/app/settings/profile'); const draft = b.locator('input[autocomplete="nickname"]'); await draft.fill('UNSAVED-OLD-TAB');
  await b.evaluate(async () => { window.compatReloads = 0; window.addEventListener('app-update-reload', () => window.compatReloads++); await (await caches.open('qa-user-data')).put('/qa-private-data', new Response('USER-DATA-SENTINEL')); });
  version = 2; await a.locator('app-updates #update').click();
  await a.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  await a.waitForFunction(() => document.querySelector('app-updates').shadowRoot.querySelector('#update').textContent.includes('下载完成'));
  a.once('dialog', d => d.accept()); await Promise.all([a.waitForEvent('load'), a.locator('app-updates #update').click()]);
  await a.locator('input[autocomplete="nickname"]').waitFor();
  await b.waitForFunction(() => document.querySelector('app-updates').shadowRoot.querySelector('#update').textContent.includes('下载完成'));
  assert.equal(await draft.inputValue(), 'UNSAVED-OLD-TAB'); assert.equal(await b.evaluate(() => window.compatReloads), 0);
  b.once('dialog', d => d.dismiss()); await b.locator('app-updates #update').click();
  assert.equal(await draft.inputValue(), 'UNSAVED-OLD-TAB');
  b.once('dialog', d => d.dismiss()); await b.locator('.settings-tabs a[href="/app/settings/ai"]').click();
  assert.equal(await draft.inputValue(), 'UNSAVED-OLD-TAB'); assert.match(b.url(), /\/settings\/profile$/);
  assert.equal(await b.evaluate(async () => (await (await caches.open('qa-user-data')).match('/qa-private-data')).text()), 'USER-DATA-SENTINEL');
  const preserved = await b.evaluate(async () => (await (await caches.open('ai-office-assets-compat-v1')).keys()).map(r => new URL(r.url).pathname));
  assert(preserved.some(url => url.includes('AiSettings-') && !url.includes('release2-')));
  if (evict) await b.evaluate(async () => { const cache = await caches.open('ai-office-assets-compat-v1'); for (const request of await cache.keys()) if (request.url.includes('/AiSettings-')) await cache.delete(request); });
  b.once('dialog', d => d.accept()); await b.locator('.settings-tabs a[href="/app/settings/ai"]').click();
  if (!evict) {
   await b.locator('.ai-model-settings').first().waitFor(); assert.deepEqual(errors, []);
   assert(!missing.some(file => file.includes('AiSettings-')));
   assert.equal(await b.evaluate(() => window.compatReloads), 0);
   results.push({ name, passed: true, checks: ['actual old c3 client', 'all V2 JS/CSS URLs replaced', 'old server URLs return 404', 'other tab activation never reloads draft', 'update/route cancellation preserves real nickname edit', 'previously unloaded old AI route served from preserved assets', 'user cache unchanged', 'no API writes'] });
  } else {
   await b.getByRole('heading', { name: '页面资源暂时不可用' }).waitFor();
   assert.equal(await b.locator('.main-nav').count(), 1); assert.equal(await b.evaluate(() => window.compatReloads), 0);
   b.once('dialog', d => d.dismiss()); await b.getByRole('button', { name: '检查并确认更新' }).click();
   await b.getByRole('heading', { name: '页面资源暂时不可用' }).waitFor(); assert.equal(await b.evaluate(() => window.compatReloads), 0);
   await b.screenshot({ path: path.join(output, 'local-resource-recovery.png'), fullPage: true });
   b.once('dialog', d => d.accept()); await Promise.all([b.waitForEvent('load'), b.getByRole('button', { name: '检查并确认更新' }).click()]);
   await b.locator('.ai-model-settings').first().waitFor();
   results.push({ name, passed: true, checks: ['evicted static asset yields local recovery within shell', 'no unsolicited reload', 'cancel keeps recovery page', 'explicit shared confirmation reloads new module graph'] });
  }
  assert.deepEqual(writes, []); console.log(`PASS ${name}`);
  const installContext = await browser.newContext({ serviceWorkers: 'block' });
  await installContext.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const install = await installContext.newPage(); await install.goto(origin + '/app'); await install.locator('.main-nav').waitFor();
  await install.evaluate(() => {
   window.installPrompts = 0; const event = new Event('beforeinstallprompt', { cancelable: true });
   Object.assign(event, { prompt: async () => { window.installPrompts++; }, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) }); window.dispatchEvent(event);
  });
  const action = install.locator('app-updates #entries button'); await action.waitFor({ state: 'attached' });
  for (const scope of ['ai:synthetic:project1', 'ai:another:project2', 'guest', 'ai:synthetic:']) {
   await install.evaluate(scope => window.dispatchEvent(new CustomEvent('app-notification-scope', { detail: scope })), scope); assert.equal(await action.count(), 1);
  }
  await install.locator('.main-nav a[href="/app/settings"]').click(); await install.waitForURL('**/settings/profile');
  await install.locator('.main-nav a[href="/app"]').click(); await install.waitForURL('**/app'); assert.equal(await action.count(), 1);
  assert.equal(await install.evaluate(() => window.installPrompts), 0);
  await install.locator('app-updates #bell').click(); await action.click();
  assert.equal(await install.evaluate(() => window.installPrompts), 1); assert.equal(await action.count(), 0);
  await install.evaluate(() => window.dispatchEvent(new Event('appinstalled'))); assert.equal(await action.count(), 0);
  results.push({ name: name + ': installation history', passed: true, checks: ['valid native opportunity restored across account/project/guest scopes', 'dashboard remount restores history action without repeat toast', 'native prompt only on user history click', 'consumed/installed action removed'] });
  await installContext.close();
  if (evict) {
   const missingContext = await browser.newContext({ serviceWorkers: 'block' });
   await missingContext.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
   const failedAsset = /\/assets\/[^/]*AiSettings-[^/]+\.js$/;
   await missingContext.route(failedAsset, route => route.fulfill({ status: 404, body: 'temporarily unavailable' }));
   const recovery = await missingContext.newPage(); let loads = 0; recovery.on('load', () => loads++);
   await recovery.goto(origin + '/app/settings/ai'); await recovery.getByRole('heading', { name: '页面资源暂时不可用' }).waitFor();
   await recovery.waitForFunction(() => document.querySelector('app-updates').shadowRoot.querySelector('#update').textContent.includes('重新加载'));
   const initialLoads = loads;
   recovery.once('dialog', d => d.dismiss()); await recovery.getByRole('button', { name: '检查并确认更新' }).click();
   assert.equal(loads, initialLoads); await recovery.getByRole('heading', { name: '页面资源暂时不可用' }).waitFor();
   await missingContext.unroute(failedAsset);
   recovery.once('dialog', d => d.accept()); await Promise.all([recovery.waitForEvent('load'), recovery.getByRole('button', { name: '检查并确认更新' }).click()]);
   await recovery.locator('.ai-model-settings').first().waitFor(); assert.equal(loads, initialLoads + 1);
   results.push({ name: 'same-version-resource-recovery', passed: true, checks: ['missing lazy resource does not replace shell', 'recovery works even if SW registration is blocked', 'honest reload state, no claimed downloaded update', 'cancel never reloads', 'explicit shared confirmation reloads exactly once after network recovery'] });
   await missingContext.close();
  }
 } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
}
try { await run('legacy-c3-to-fixed-worker', baseline); await run('evicted-assets-recovery', dist, true); writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); }
finally { await browser.close(); }
