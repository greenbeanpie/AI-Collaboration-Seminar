import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(repository, 'output', 'desktop-smoke');
await mkdir(output, { recursive: true });
const ids = { accountA: '11111111-1111-4111-8111-111111111111', accountB: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: '22222222-2222-4222-8222-222222222222', taskId: '33333333-3333-4333-8333-333333333333', downloadId: '44444444-4444-4444-8444-444444444444' };
const bytes = 9 * 1048576 + 128;
for (const name of ['native-upload.txt', 'native-download.txt']) {
  const handle = await open(path.join(output, name), 'w');
  const block = Buffer.alloc(64 * 1024, 'Buwei Windows native smoke fixture.\r\n');
  for (let offset = 0; offset < bytes; offset += block.length) await handle.write(block.subarray(0, Math.min(block.length, bytes - offset)));
  await handle.sync(); await handle.close();
}
const fixture = { ...ids, sizeBytes: bytes, uploadPath: path.join(output, 'native-upload.txt'), downloadPath: path.join(output, 'native-download.txt') };
await writeFile(path.join(output, 'fixture.json'), JSON.stringify(fixture, null, 2));
const files = new Map([[ids.downloadId, { fileId: ids.downloadId, accountId: ids.accountA, name: 'native-download.txt', status: 'available', sizeBytes: bytes, path: fixture.downloadPath }]]);
const sessions = new Map(), intents = new Map(), notifications = new Map([[ids.accountA, []], [ids.accountB, []]]);
const events = []; let controls = { failDownloadOnce: true, failPartOnce: true, failRegistrationOnce: false, registrationFailed: false, partFailed: false, downloadFailed: false, chunkDelayMs: 10 };
let updateHandler;
if (process.env.BUWEI_SMOKE_INSTALLER) {
  const { createUpdateSmokeHandler } = await import('./update-smoke-routes.mjs');
  updateHandler = createUpdateSmokeHandler({ installerPath: process.env.BUWEI_SMOKE_INSTALLER, version: process.env.BUWEI_SMOKE_UPDATE_VERSION ?? '0.1.1', ...(process.env.BUWEI_SMOKE_SIGNATURE ? { signaturePath: process.env.BUWEI_SMOKE_SIGNATURE } : {}) });
}
const account = req => /(?:^|;\s*)ai_office_session=smoke-a(?:;|$)/.test(req.headers.cookie ?? '') ? ids.accountA : /(?:^|;\s*)ai_office_session=smoke-b(?:;|$)/.test(req.headers.cookie ?? '') ? ids.accountB : undefined;
const record = (req, actor, extra = {}) => events.push({ number: events.length + 1, at: new Date().toISOString(), method: req.method, path: new URL(req.url, 'http://127.0.0.1:5173').pathname, actor: actor ?? null, native: !req.headers['sec-fetch-mode'], cookiePresent: Boolean(req.headers.cookie), ...extra });
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const envelope = (res, data, status = 200) => json(res, status, { data, requestId: randomUUID() });
const failure = (res, message, status = 400) => json(res, status, { error: { message, code: 'SMOKE_FIXTURE', retryable: status >= 500 }, requestId: randomUUID() });
async function body(req) { const chunks = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > 100_000_000) throw new Error('fixture body too large'); chunks.push(chunk); } return Buffer.concat(chunks); }
async function bodyJson(req) { return JSON.parse((await body(req)).toString('utf8') || '{}'); }

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>补位 · 本机原生验证</title><style>body{font:16px system-ui;background:#f1f5f9;color:#142135;margin:0;padding:32px}main{max-width:1000px;margin:auto;background:white;border-radius:16px;padding:28px;box-shadow:0 8px 40px #17345514}h1{margin:0 0 14px;font-size:28px}.badge{background:#e8f4e8;color:#23582a;padding:6px 10px;border-radius:6px}button{padding:10px 16px;margin:12px 8px 4px 0;background:#213b70;color:white;border:0;border-radius:7px;cursor:pointer}pre{white-space:pre-wrap;background:#101c31;color:#cde0ff;padding:18px;border-radius:8px;max-height:400px;overflow:auto}code{overflow-wrap:anywhere}</style><main><h1>补位 Windows 客户端 · 本机验证</h1><span class="badge">固定 loopback 环境 · 无生产数据 · 无付费请求</span><p>验证使用真实 Tauri / WebView2 桥接、HttpOnly 测试会话、Rust 文件缓存和网络传输。当前账号：<strong id="account">准备中</strong></p><p>选择上传附件时，在系统选择器填写：<code>${fixture.uploadPath.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code></p><button id="stage">选择上传附件</button><button id="retry">继续附件传输</button><button id="switch">切换测试账号</button><button id="state">检查本机队列</button><button id="download">下载测试附件</button><pre id="log">正在连接原生桥接…</pre></main><script>
window.smoke={ids:${JSON.stringify(ids)},events:[],accountId:null};
const log=value=>{window.smoke.events.push(value);document.querySelector('#log').textContent=window.smoke.events.map(row=>JSON.stringify(row,null,2)).join('\\n');};
window.smoke.invoke=(command,args={})=>window.__TAURI_INTERNALS__.invoke(command,args);
window.smoke.report=async(requestId)=>window.smoke.invoke('desktop_report_state',{state:{protocol:1,accountId:window.smoke.accountId,dirty:false,busy:false,durable:true,...(requestId==null?{}:{requestId})}});
window.smoke.login=async(letter='a')=>{await fetch('/_smoke/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:letter})});const value=await(await fetch('/api/v1/auth/session')).json();window.smoke.accountId=value.data.user.id;document.querySelector('#account').textContent=letter.toUpperCase();await window.smoke.report();return value.data.user.id;};
window.addEventListener('desktop-prepare-update',event=>{log({event:'prepare-update',requestId:event.detail.requestId});void window.smoke.report(event.detail.requestId);});
window.addEventListener('desktop-prepare-exit',event=>{log({event:'prepare-exit',requestId:event.detail.requestId});void window.smoke.report(event.detail.requestId);});
window.addEventListener('desktop-resume',()=>{log({event:'desktop-resume'});void window.smoke.report();});
const run=async(action)=>{try{log({result:await action()});}catch(error){log({error:String(error)});}};
document.querySelector('#stage').onclick=()=>run(async()=>{const rows=await window.smoke.invoke('desktop_stage_files',{projectId:window.smoke.ids.projectId,taskId:window.smoke.ids.taskId,maxFiles:1});log({staged:rows});await window.smoke.invoke('desktop_transfer_files',{projectId:window.smoke.ids.projectId});});
document.querySelector('#retry').onclick=()=>run(()=>window.smoke.invoke('desktop_transfer_files',{projectId:window.smoke.ids.projectId}));
document.querySelector('#switch').onclick=()=>run(()=>window.smoke.login(window.smoke.accountId===window.smoke.ids.accountA?'b':'a'));
document.querySelector('#state').onclick=()=>run(()=>window.smoke.invoke('desktop_list_files',{projectId:window.smoke.ids.projectId}));
document.querySelector('#download').onclick=()=>run(async()=>{await window.smoke.invoke('desktop_cache_project',{projectId:window.smoke.ids.projectId,files:[{fileId:window.smoke.ids.downloadId,name:'native-download.txt',sizeBytes:${bytes}}]});await window.smoke.invoke('desktop_transfer_files',{projectId:window.smoke.ids.projectId});});
window.smoke.ready=(async()=>{const session=await fetch('/api/v1/auth/session');if(session.ok){const value=await session.json();window.smoke.accountId=value.data.user.id;document.querySelector('#account').textContent=window.smoke.accountId===window.smoke.ids.accountA?'A':'B';await window.smoke.report();}else await window.smoke.login('a');const hello=await window.smoke.invoke('desktop_hello');log({hello,account:window.smoke.accountId});return hello;})();
</script></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (updateHandler && await updateHandler(req, res)) return;
    const url = new URL(req.url, 'http://127.0.0.1:5173'), pathname = url.pathname;
    if (pathname === '/_smoke/fixture') return json(res, 200, fixture);
    if (pathname === '/_smoke/stats') return json(res, 200, { events, controls, files: [...files.values()].map(({ path: _path, ...file }) => file), sessions: [...sessions.values()].map(session => ({ sessionId: session.sessionId, fileId: session.fileId, status: session.status, parts: [...session.parts.values()].map(part => ({ partNumber: part.partNumber, sizeBytes: part.sizeBytes, accepts: part.accepts })) })) });
    if (pathname === '/_smoke/control' && req.method === 'POST') { controls = { ...controls, ...await bodyJson(req) }; return json(res, 200, controls); }
    if (pathname === '/_smoke/login' && req.method === 'POST') { const value = await bodyJson(req); const letter = value.account === 'b' ? 'b' : 'a'; res.setHeader('Set-Cookie', 'ai_office_session=smoke-' + letter + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400'); return json(res, 200, { loggedIn: true }); }
    if (pathname === '/_smoke/notification' && req.method === 'POST') { const value = await bodyJson(req); const id = value.account === 'b' ? ids.accountB : ids.accountA; notifications.get(id).push({ id: randomUUID(), readAt: null, dismissedAt: null, url: '/app/settings/notifications' }); return json(res, 200, { count: notifications.get(id).length }); }
    if (!pathname.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html); }
    const actor = account(req); record(req, actor, { range: req.headers.range ?? null }); if (!actor) return failure(res, 'Smoke session required', 401);
    if (pathname === '/api/v1/auth/session') return envelope(res, { user: { id: actor, username: 'fixture', displayName: actor === ids.accountA ? '测试账号 A' : '测试账号 B', email: null, isAdmin: false, role: 'user' } });
    if (pathname === '/api/v1/notifications/settings') return envelope(res, { pushEnabled: true });
    if (pathname === '/api/v1/notifications') return envelope(res, { items: notifications.get(actor), nextCursor: null });
    const base = '/api/v1/projects/' + ids.projectId;
    if (pathname === base + '/files' && req.method === 'POST') { const value = await bodyJson(req); const key = actor + ':' + req.headers['idempotency-key']; let id = intents.get(key); if (!id) { id = randomUUID(); intents.set(key, id); files.set(id, { fileId: id, accountId: actor, name: value.fileName, status: 'pending', sizeBytes: 0 }); } return envelope(res, { fileId: id, upload: { method: 'PUT', url: base + '/files/' + id + '/content' } }, 201); }
    const fileRoute = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)(.*)$/);
    if (fileRoute) {
      const [, projectId, fileId, tail] = fileRoute, file = files.get(fileId);
      if (projectId !== ids.projectId || !file || file.accountId !== actor) return failure(res, 'Smoke file not accessible', 403);
      if (tail === '/content' && req.method === 'GET') {
        if (file.status !== 'available') return failure(res, 'Smoke file pending', 409);
        const size = (await stat(file.path)).size; const requested = req.headers.range?.match(/^bytes=(\d+)-$/); const offset = requested ? Number(requested[1]) : 0;
        if (offset >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
        res.writeHead(requested ? 206 : 200, { 'Content-Type': 'text/plain', 'Content-Length': size - offset, 'Accept-Ranges': 'bytes', 'ETag': '"smoke-immutable"', ...(requested ? { 'Content-Range': `bytes ${offset}-${size - 1}/${size}` } : {}) });
        const breakAfter = controls.failDownloadOnce && !controls.downloadFailed && offset === 0 ? 2 * 1048576 : Infinity; let sent = 0;
        for await (const chunk of createReadStream(file.path, { start: offset, highWaterMark: 64 * 1024 })) { if (res.destroyed) break; res.write(chunk); sent += chunk.length; if (sent >= breakAfter) { controls.downloadFailed = true; record(req, actor, { action: 'download-interrupted', bytes: sent }); await new Promise(resolve => setTimeout(resolve, 50)); res.destroy(); break; } if (controls.chunkDelayMs) await new Promise(resolve => setTimeout(resolve, controls.chunkDelayMs)); }
        if (!res.destroyed) res.end(); return;
      }
      if (tail === '/uploads' && req.method === 'POST') { const value = await bodyJson(req); let session = [...sessions.values()].find(row => row.fileId === fileId); if (!session) { session = { sessionId: randomUUID(), fileId, accountId: actor, sizeBytes: value.sizeBytes, partBytes: 8 * 1048576, status: 'uploading', parts: new Map() }; sessions.set(session.sessionId, session); } return envelope(res, { sessionId: session.sessionId, partBytes: session.partBytes }); }
      const operation = tail.match(/^\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/);
      if (operation) {
        const [, sessionId, partString, complete] = operation, session = sessions.get(sessionId);
        if (!session || session.accountId !== actor || session.fileId !== fileId) return failure(res, 'Invalid fixture upload session', 403);
        if (!partString && !complete) return envelope(res, { sessionId, status: session.status, sizeBytes: session.sizeBytes, partBytes: session.partBytes, parts: [...session.parts.values()].map(({ partNumber, sizeBytes }) => ({ partNumber, sizeBytes })) });
        if (partString && req.method === 'PUT') { const part = Number(partString), value = await body(req); const expected = Math.min(session.partBytes, session.sizeBytes - (part - 1) * session.partBytes); if (value.length !== expected || Number(req.headers['x-part-size']) !== expected) return failure(res, 'Wrong fixture part length'); const old = session.parts.get(part); const partPath = path.join(output, fileId + '-part-' + part + '.bin'); await writeFile(partPath, value); session.parts.set(part, { partNumber: part, sizeBytes: value.length, accepts: (old?.accepts ?? 0) + 1, path: partPath }); record(req, actor, { action: 'part-accepted', partNumber: part, sizeBytes: value.length }); if (controls.failPartOnce && !controls.partFailed && part === 1) { controls.partFailed = true; return res.destroy(); } return envelope(res, { partNumber: part, sizeBytes: value.length }, 201); }
        if (complete && req.method === 'POST') { const parts = [...session.parts.values()].sort((a, b) => a.partNumber - b.partNumber); if (parts.reduce((sum, row) => sum + row.sizeBytes, 0) !== session.sizeBytes) return failure(res, 'Fixture upload incomplete', 409); const destination = path.join(output, fileId + '-uploaded.txt'); const handle = await open(destination, 'w'); const hash = createHash('sha256'); for (const part of parts) { const piece = await readFile(part.path); await handle.write(piece); hash.update(piece); } await handle.sync(); await handle.close(); session.status = 'complete'; Object.assign(file, { status: 'available', sizeBytes: session.sizeBytes, path: destination, sha256: hash.digest('hex') }); return envelope(res, { fileId, sizeBytes: file.sizeBytes }); }
      }
    }
    if (pathname.startsWith(base + '/tasks/' + ids.taskId + '/files')) {
      if (req.method === 'POST' || req.method === 'PUT') { const value = await bodyJson(req); const file = files.get(value.fileId); if (!file || file.accountId !== actor || file.status !== 'available') return failure(res, 'Unfinished fixture file cannot register', 409); if (controls.failRegistrationOnce && !controls.registrationFailed) { controls.registrationFailed = true; return failure(res, 'Fixture material revision conflict', 409); } file.materialId ??= randomUUID(); file.versionId ??= randomUUID(); file.registered = true; record(req, actor, { action: 'file-registered', fileId: file.fileId }); return envelope(res, { materialId: file.materialId, versionId: file.versionId, fileId: file.fileId, name: file.name, revision: 1, taskId: ids.taskId, archivedAt: null, materialArchivedAt: null, deletedAt: null, lifecycleVersion: 1, canManage: true }, 201); }
      return envelope(res, { items: [...files.values()].filter(file => file.accountId === actor && file.registered).map(file => ({ fileId: file.fileId, versionId: file.versionId, materialId: file.materialId, name: file.name, revision: 1, taskId: ids.taskId, archivedAt: null, materialArchivedAt: null, deletedAt: null })) });
    }
    return failure(res, 'Unsupported local fixture API', 404);
  } catch (error) { if (!res.headersSent) failure(res, String(error), 500); else res.destroy(); }
});
server.listen(5173, '127.0.0.1', () => console.log(JSON.stringify({ listening: 'http://127.0.0.1:5173', fixture, output })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
