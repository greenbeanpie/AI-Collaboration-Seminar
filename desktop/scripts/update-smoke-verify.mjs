// API-only acceptance: raw CDP Runtime / Network commands, no UI or computer automation.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const origin = 'http://127.0.0.1:5173';
const cdpOrigin = process.env.BUWEI_CDP_URL ?? 'http://127.0.0.1:9223';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.BUWEI_SMOKE_OUTPUT ?? path.join(repository, 'output', 'desktop-smoke');
const appData = path.join(process.env.LOCALAPPDATA, 'cn.buwei.desktop.smoke');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), method: 'CLI + raw CDP APIs only', checks: [], limitations: ['Tests local signed Debug A/B installers; no production service is exercised.', 'Manual update uses the same save handshake; the five-minute automatic idle trigger is not exercised.', 'IndexedDB persistence marker verifies storage retention; production frontend offline queue migration is not exercised.'] };
const pass = (name, evidence) => { report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let session;
async function connect() {
  const targets = await (await fetch(cdpOrigin + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
  const target = targets.find(target => target.type === 'page' && target.url.startsWith(origin));
  assert.ok(target, 'Native loopback WebView2 target must exist');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); const entry = pending.get(value.id); if (!entry) return; pending.delete(value.id); clearTimeout(entry.timer); if (value.error) entry.reject(new Error(value.error.message)); else entry.resolve(value.result); });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP disconnected')); } pending.clear(); });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP command timeout: ' + method)); }, 120000); pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params })); });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  return { call, evaluate, close: () => socket.close() };
}
const invoke = (command, args = {}) => session.evaluate(`window.smoke.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
async function snapshotNative() {
  const result = {};
  async function walk(dir, relative = '') {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) { const name = path.join(relative, entry.name), full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full, name); else { const data = await readFile(full); result[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }; } }
  }
  await walk(path.join(appData, 'attachments')); return result;
}
try {
  for (let attempt = 0; !session && attempt < 30; attempt++) {
    try { session = await connect(); } catch { await sleep(500); }
  }
  assert.ok(session, 'Native smoke client must start its loopback CDP endpoint');
  await session.evaluate('window.smoke.ready');
  const beforeHello = await invoke('desktop_hello'); assert.equal(beforeHello.version, '0.1.0');
  pass('installed A connected through raw CDP', { version: beforeHello.version });
  await session.evaluate("window.smoke.login('b')"); // B must survive restart without fixture auto-login replacing it.
  await invoke('desktop_set_auto_restart', { enabled: false });
  let update = await invoke('desktop_check_update');
  for (let attempt = 0; update.phase !== 'ready' && attempt < 60; attempt++) { await sleep(1000); update = await invoke('desktop_update_state'); }
  assert.equal(update.phase, 'ready'); assert.equal(update.version, '0.1.1');
  pass('signed B downloaded and ready', { version: update.version, phase: update.phase });
  // Corrupt only the disposable updater cache, then prove no installation can execute it.
  const installerCache = path.join(appData, 'updates', 'installer.bin');
  const original = await readFile(installerCache); const damaged = Buffer.from(original); damaged[0] ^= 1; await writeFile(installerCache, damaged);
  const tamperResult = await invoke('desktop_restart_update').then(() => ({ rejected: false }), error => ({ rejected: true, reason: String(error) }));
  assert.ok(tamperResult.rejected); assert.equal((await invoke('desktop_hello')).version, '0.1.0');
  pass('tampered cached installer rejected and A remains running', tamperResult);
  await invoke('desktop_check_update'); assert.equal((await invoke('desktop_update_state')).phase, 'ready');
  await session.evaluate(`window.smoke.dirty=true;window.smoke.report=async(requestId)=>window.smoke.invoke('desktop_report_state',{state:{protocol:1,accountId:window.smoke.accountId,dirty:window.smoke.dirty,busy:false,durable:true,...(requestId==null?{}:{requestId})}});window.smoke.report()`);
  const dirtyResult = await invoke('desktop_restart_update').then(() => ({ rejected: false }), error => ({ rejected: true, reason: String(error) }));
  assert.ok(dirtyResult.rejected); assert.equal((await invoke('desktop_hello')).version, '0.1.0');
  pass('dirty save handshake rejects restart and A remains running', dirtyResult);
  const marker = randomUUID();
  await session.evaluate(`(async()=>{localStorage.setItem('buwei-update-marker',${JSON.stringify(marker)});document.cookie='buwei_update_marker='+${JSON.stringify(marker)}+';Path=/;Max-Age=86400;SameSite=Lax';await new Promise((resolve,reject)=>{const req=indexedDB.open('buwei-update-persistence',1);req.onupgradeneeded=()=>req.result.createObjectStore('markers');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction('markers','readwrite');tx.objectStore('markers').put(${JSON.stringify(marker)},'offline-draft');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}});window.smoke.dirty=false;await window.smoke.report()})()`);
  const beforeCookies = (await session.call('Network.getCookies', { urls: [origin] })).cookies;
  const beforeSession = beforeCookies.find(cookie => cookie.name === 'ai_office_session');
  assert.equal(beforeSession?.value, 'smoke-b'); assert.ok(beforeSession.httpOnly);
  const beforeFiles = await snapshotNative(); assert.ok(Object.keys(beforeFiles).some(name => name.endsWith('manifest.json')), 'Existing native cache manifest required');
  pass('persistence baseline recorded', { account: 'B', cookieHttpOnly: true, nativeFiles: Object.keys(beforeFiles).length, indexedDb: 'offline-draft' });
  // NSIS exits A; losing the CDP transport is expected. Never close the browser or kill processes.
  const installPromise = invoke('desktop_restart_update').catch(error => String(error));
  await sleep(1000); session.close(); session = null; void installPromise;
  const deadline = Date.now() + 180000; let hello;
  while (Date.now() < deadline) {
    try { session = await connect(); await session.evaluate('window.smoke.ready'); hello = await invoke('desktop_hello'); if (hello.version === '0.1.1') break; session.close(); session = null; } catch { session?.close(); session = null; }
    await sleep(1000);
  }
  assert.equal(hello?.version, '0.1.1', 'Signed B must install and automatically restart without UI interaction');
  pass('real NSIS upgrade and automatic restart into B', { version: hello.version });
  const after = await session.evaluate(`(async()=>{const indexedDb=await new Promise((resolve,reject)=>{const req=indexedDB.open('buwei-update-persistence',1);req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,tx=db.transaction('markers','readonly'),value=tx.objectStore('markers').get('offline-draft');value.onsuccess=()=>{resolve(value.result);db.close()};value.onerror=()=>reject(value.error)}});return{localStorage:localStorage.getItem('buwei-update-marker'),cookie:document.cookie,accountId:window.smoke.accountId,indexedDb}})()`);
  assert.equal(after.localStorage, marker); assert.equal(after.indexedDb, marker); assert.ok(after.cookie.includes('buwei_update_marker=' + marker));
  const afterCookies = (await session.call('Network.getCookies', { urls: [origin] })).cookies;
  assert.equal(afterCookies.find(cookie => cookie.name === 'ai_office_session')?.value, 'smoke-b');
  assert.equal(after.accountId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  pass('Cookie session, localStorage and IndexedDB retained', { account: 'B', markerMatched: true, indexedDbMatched: true });
  assert.deepEqual(await snapshotNative(), beforeFiles); pass('native attachment manifests and blobs retained byte-for-byte', beforeFiles);
  assert.equal(hello.autoRestart, false); pass('update restart preference retained', { autoRestart: false });
  report.passed = true; report.completedAt = new Date().toISOString();
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
finally {
  session?.close();
  const primary = path.join(output, 'update-smoke-report.json');
  let existing;
  try { existing = JSON.parse(await readFile(primary, 'utf8')); } catch { /* First run. */ }
  // A repeat invocation after a successful A -> B upgrade cannot rerun the A precondition.
  // Keep that acceptance report and record this attempt separately.
  const reportPath = existing?.passed && !report.passed && report.checks.length === 0
    ? path.join(output, `update-smoke-attempt-${Date.now()}.json`) : primary;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error, reportPath }));
}
