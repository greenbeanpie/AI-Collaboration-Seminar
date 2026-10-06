import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const runtime = process.env.BUWEI_PLAYWRIGHT_PATH ?? 'C:/Users/hmz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
const { chromium } = require(runtime);
const origin = 'http://127.0.0.1:5173';
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../output/desktop-smoke');
await mkdir(output, { recursive: true });
const fixture = await (await fetch(origin + '/_smoke/fixture')).json();
const report = { startedAt: new Date().toISOString(), native: true, checks: [], limitations: ['Production API and paid providers are not exercised.', 'Notification API polling is observable; toast display/click requires separate visual acceptance.', 'Update installation requires the separate signed two-version smoke run.'] };
const check = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); };
const controls = async value => { const response = await fetch(origin + '/_smoke/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); assert.equal(response.status, 200); };
const stats = async () => (await fetch(origin + '/_smoke/stats')).json();
const browser = await chromium.connectOverCDP(process.env.BUWEI_CDP_URL ?? 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
const page = context.pages().find(page => page.url().startsWith(origin));
assert.ok(page, 'Native WebView2 main window must be at loopback fixture');
page.setDefaultTimeout(120000);
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.smoke.invoke(command, args), { command, args });
const rows = () => invoke('desktop_list_files', { projectId: fixture.projectId });
const rejects = async (name, command, args) => { const result = await invoke(command, args).then(() => ({ rejected: false }), error => ({ rejected: true, reason: String(error) })); assert.ok(result.rejected, name + ' must reject'); check(name, result.reason); };
try {
  await page.evaluate(() => window.smoke.ready);
  await page.evaluate(() => window.smoke.login('a'));
  const hello = await invoke('desktop_hello'); assert.equal(hello.protocol, 1); check('real Tauri bridge handshake', { protocol: hello.protocol, version: hello.version });
  assert.equal(await page.evaluate(() => document.cookie.includes('ai_office_session')), false); check('session cookie is HttpOnly', 'JavaScript cannot read dummy session cookie');
  await rejects('unsupported bridge protocol', 'desktop_report_state', { state: { protocol: 2, accountId: fixture.accountA, dirty: false, busy: false, durable: true } });
  await page.evaluate(() => window.smoke.report(77)); check('nonce and durable lifecycle report accepted', { requestId: 77 });
  await rejects('arbitrary filesystem command blocked', 'plugin:fs|read_text_file', { path: 'C:\\Windows\\win.ini' });
  await rejects('untrusted extra WebView creation blocked', 'plugin:webview|create_webview_window', { options: { label: 'untrusted-smoke', url: 'https://example.invalid' } });
  await rejects('cache path traversal identifier rejected', 'desktop_cache_project', { projectId: fixture.projectId, files: [{ fileId: '../escape', name: 'escape', sizeBytes: 1 }] });
  await rejects('project path traversal identifier rejected', 'desktop_list_files', { projectId: '../escape' });
  const oldDownloads = (await rows()).filter(row => row.direction === 'download');
  for (const row of oldDownloads) { if (row.status === 'transferring') await invoke('desktop_pause_file', { projectId: fixture.projectId, id: row.id }); await invoke('desktop_remove_file', { projectId: fixture.projectId, id: row.id, discard: false }); }
  await controls({ failDownloadOnce: true, downloadFailed: false, chunkDelayMs: 10 });
  const queued = await invoke('desktop_cache_project', { projectId: fixture.projectId, files: [{ fileId: fixture.downloadId, name: 'native-download.txt', sizeBytes: fixture.sizeBytes }] });
  assert.ok(queued.some(row => row.fileId === fixture.downloadId && row.status === 'waiting')); check('native persistent download queue created', { files: queued.length });
  const interrupted = await invoke('desktop_transfer_files', { projectId: fixture.projectId }).then(() => false, () => true); assert.ok(interrupted, 'TCP interruption should not report success');
  const partial = (await rows()).find(row => row.fileId === fixture.downloadId); assert.equal(partial.status, 'failed'); assert.ok(partial.transferredBytes > 0 && partial.transferredBytes < fixture.sizeBytes); check('interrupted native download remains incomplete', { transferredBytes: partial.transferredBytes, sizeBytes: partial.sizeBytes });
  await invoke('desktop_transfer_files', { projectId: fixture.projectId });
  const complete = (await rows()).find(row => row.fileId === fixture.downloadId); assert.equal(complete.status, 'complete'); assert.equal(complete.transferredBytes, fixture.sizeBytes);
  const rangeEvents = (await stats()).events.filter(event => event.native && event.path.endsWith('/content') && event.range && Number(event.range.match(/bytes=(\d+)/)?.[1]) > 0);
  assert.ok(rangeEvents.length > 0, 'Native retry must send nonzero Range'); check('native Range retry completes without restarting download', { ranges: rangeEvents.map(event => event.range), bytes: complete.transferredBytes });
  const appData = process.env.LOCALAPPDATA;
  if (appData) {
    const blob = path.join(appData, 'cn.buwei.desktop.smoke', 'attachments', fixture.accountA, complete.id + '.blob');
    const [actual, expected] = await Promise.all([readFile(blob), readFile(fixture.downloadPath)]); assert.deepEqual(actual, expected); check('disk cache bytes match fixture exactly', { sizeBytes: actual.length });
  }
  await page.reload(); await page.evaluate(() => window.smoke.ready);
  assert.equal((await rows()).find(row => row.id === complete.id)?.status, 'complete'); check('native queue survives document reload', { id: complete.id });
  await page.evaluate(() => window.smoke.login('b'));
  assert.ok(!(await rows()).some(row => row.id === complete.id)); check('account B cannot enumerate account A cache', { visibleFiles: (await rows()).length });
  await rejects('account B cannot export account A cache', 'desktop_export_file', { projectId: fixture.projectId, id: complete.id });
  await page.evaluate(() => window.smoke.login('a')); assert.ok((await rows()).some(row => row.id === complete.id)); check('account A cache retained after account switch', { id: complete.id });
  if (process.argv.includes('--stage-upload')) {
    console.log('OPEN FILE DIALOG: choose ' + fixture.uploadPath);
    const staged = await invoke('desktop_stage_files', { projectId: fixture.projectId, taskId: fixture.taskId, maxFiles: 1 }); assert.equal(staged.length, 1); check('real native file picker staged bytes', { name: staged[0].name, sizeBytes: staged[0].sizeBytes });
  }
  const pendingUploads = (await rows()).filter(row => row.direction === 'upload' && row.status !== 'complete');
  if (pendingUploads.length) {
    await controls({ failPartOnce: true, partFailed: false });
    const uploadInterrupted = await invoke('desktop_transfer_files', { projectId: fixture.projectId }).then(() => false, () => true); assert.ok(uploadInterrupted, 'Part response interruption must retain pending status');
    const pending = await invoke('desktop_pending_files'); assert.ok(pending.pendingUploads > 0);
    assert.ok(!(await rows()).filter(row => pendingUploads.some(before => before.id === row.id)).some(row => row.status === 'complete')); check('unknown upload response preserves submission gate', { pendingUploads: pending.pendingUploads });
    await controls({ failRegistrationOnce: true, registrationFailed: false });
    const registrationRejected = await invoke('desktop_transfer_files', { projectId: fixture.projectId }).then(() => false, () => true); assert.ok(registrationRejected, 'Registration conflict must not complete spool entry');
    const failed = (await rows()).find(row => pendingUploads.some(before => before.id === row.id) && row.status === 'failed'); assert.ok(failed); assert.ok((await invoke('desktop_pending_files')).pendingUploads > 0); check('registration conflict keeps task submission blocked', { status: failed.status, error: failed.error });
    await invoke('desktop_resume_file', { projectId: fixture.projectId, id: failed.id });
    const finished = (await rows()).find(row => row.id === failed.id); assert.equal(finished.status, 'complete');
    const uploadStats = await stats(); const session = uploadStats.sessions.find(session => session.fileId === finished.fileId); assert.ok(session.parts.every(part => part.accepts === 1)); assert.ok(uploadStats.files.find(file => file.fileId === finished.fileId)?.registered); check('native multipart resume reconciles accepted parts and registers once', { parts: session.parts, status: session.status });
  } else report.limitations.push('Native picker upload was not exercised; rerun with --stage-upload and choose the generated fixture file.');
  if (process.argv.includes('--notifications')) {
    console.log('Waiting for native notification baseline poll (up to 70 seconds)…');
    const started = Date.now(); const count = () => stats().then(value => value.events.filter(event => event.native && event.actor === fixture.accountA && event.path === '/api/v1/notifications').length);
    const initial = await count(); while (await count() <= initial && Date.now() - started < 75000) await new Promise(resolve => setTimeout(resolve, 3000));
    assert.ok(await count() > initial, 'Native notification poll expected within one interval'); check('native notification cookie polling', { baselinePolls: await count() });
    await fetch(origin + '/_smoke/notification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'a' }) });
    const before = await count(), second = Date.now(); while (await count() <= before && Date.now() - second < 75000) await new Promise(resolve => setTimeout(resolve, 3000));
    assert.ok(await count() > before); check('native poll consumes new notification fixture', { polls: await count() });
  }
  const requests = await stats(); assert.ok(requests.events.some(event => event.native && event.cookiePresent && event.path === '/api/v1/auth/session')); check('Rust authenticated HTTP requests observed by fixture', { nativeSessionChecks: requests.events.filter(event => event.native && event.path === '/api/v1/auth/session').length });
  await page.screenshot({ path: path.join(output, 'native-smoke.png'), fullPage: true });
  report.completedAt = new Date().toISOString(); report.passed = true;
  await writeFile(path.join(output, 'server-stats.json'), JSON.stringify(requests, null, 2));
} catch (error) {
  report.passed = false; report.error = String(error); process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'native-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: path.join(output, 'native-smoke-report.json'), error: report.error ?? null }));
  await browser.close();
}
