import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Attach only to a separately built debug startup fixture. No production service,
// account, installer, device installation, or model is used by this test.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BUWEI_PLAYWRIGHT_PATH ?? 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/native-startup');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: [], limitations: ['Standalone Windows debug WebView2 fixture; no production installation or upgrade acceptance.', 'Android first-use and offline restart need device acceptance.', 'Cached fixture handshake is tested; full offline project/data flow has separate web tests.'] };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); };
const browser = await chromium.connectOverCDP(process.env.BUWEI_CDP_URL ?? 'http://127.0.0.1:9223');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(35000);
const waitURL = async target => {
  const deadline = Date.now() + 35000;
  while (page.url() !== target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(page.url(), target);
};
const origin = 'http://127.0.0.1:5173';
const shell = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本机启动验证</title><body><h1>已缓存的工作区</h1><script>window.fixtureReady=window.__TAURI_INTERNALS__.invoke('desktop_hello').then(value=>{document.body.dataset.ready=value.version;return value;});</script></body></html>`;
const worker = `self.addEventListener('install',event=>{event.waitUntil(caches.open('native-startup-fixture').then(cache=>cache.add('/')).then(()=>self.skipWaiting()));});self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});self.addEventListener('fetch',event=>{if(event.request.mode==='navigate')event.respondWith(caches.match('/').then(response=>response||fetch(event.request)));});`;
let server;
try {
  // Start the executable while no server is running on the debug origin.
  await waitURL('http://tauri.localhost/index.html?recovery=1');
  assert.match(await page.locator('#detail').innerText(), /草稿和附件仍保留/);
  check('first-use network failure returns to bundled recovery', { url: page.url(), message: await page.locator('#status').innerText() });
  const localRejected = await page.evaluate(async () => { try { await window.__TAURI_INTERNALS__.invoke('desktop_pending_files'); return false; } catch { return true; } });
  assert.ok(localRejected);
  check('bundled page cannot read business attachment state', localRejected);
  await page.screenshot({ path: path.join(output, 'windows-recovery.png') });
  server = http.createServer((request, response) => {
    if (request.url === '/sw.js') { response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }); response.end(worker); }
    else { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(shell); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5173, '127.0.0.1', resolve); });
  await page.evaluate(() => { void window.__TAURI_INTERNALS__.invoke('desktop_open_app'); });
  await waitURL(`${origin}/`);
  const hello = await page.evaluate(() => window.fixtureReady);
  assert.equal(hello.version, '0.1.1');
  check('native retry opens original remote origin and completes handshake', hello.version);
  const remoteRejected = await page.evaluate(async () => { try { await window.__TAURI_INTERNALS__.invoke('desktop_open_app'); return false; } catch { return true; } });
  assert.ok(remoteRejected);
  check('remote page cannot call bundled startup command', remoteRejected);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await new Promise(resolve => server.close(resolve));
  server = undefined;
  await page.goto('http://tauri.localhost/index.html?recovery=1');
  await page.evaluate(() => { void window.__TAURI_INTERNALS__.invoke('desktop_open_app'); });
  await waitURL(`${origin}/`);
  assert.equal((await page.evaluate(() => window.fixtureReady)).version, '0.1.1');
  // Allow the entire native watchdog interval to expire after the cached hello.
  await new Promise(resolve => setTimeout(resolve, 22000));
  assert.equal(page.url(), `${origin}/`);
  assert.equal(await page.locator('body').getAttribute('data-ready'), '0.1.1');
  check('cached offline app handshake prevents false startup recovery', { url: page.url(), serverStopped: true });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error); process.exitCode = 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'windows-startup-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error ?? null, output }));
}
