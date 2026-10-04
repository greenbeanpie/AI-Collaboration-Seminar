/** Local browser + actual Workers/D1/R2 + actual BridgeRunner acceptance.
 * Uses a fake test cookie from ignored ui-fixture.json and a simulated DSH adapter.
 * No provider calls, personal DSH settings, production URLs or browser credentials.
 * Run: node scripts/verify-dsh-bridge-browser.mjs --root <integrated-worktree>
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootIndex = process.argv.indexOf('--root');
const root = resolve(rootIndex < 0 ? '.' : process.argv[rootIndex + 1]);
if (process.argv.includes('--fresh')) execFileSync(process.execPath, [join(root, 'scripts/verify-dsh-bridge-local.mjs'), '--prepare-ui'], { cwd: root, windowsHide: true, stdio: 'pipe' });
const fixture = JSON.parse(await readFile(join(root, 'output/dsh-bridge-local/ui-fixture.json'), 'utf8'));
assert(['127.0.0.1', 'localhost'].includes(new URL(fixture.origin).hostname), 'Only local fixture backend is permitted');
assert(fixture.cookie.startsWith('ai_office_session='));
const dist = join(root, 'frontend/dist');
const out = resolve('output/dsh-bridge-browser'); await mkdir(out, { recursive: true });
const origin = 'http://127.0.0.1:5290';
const npx = process.env.BRIDGE_BROWSER_NPX || join(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
const sessionName = `bridge-${randomUUID().slice(0, 8)}`;
const cli = join(root, 'backend/node_modules/wrangler/bin/wrangler.js');
const sha = value => createHash('sha256').update(value).digest('hex');
function query(sql) { const stdout = execFileSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local', '--persist-to', fixture.state, '--command', sql, '--json'], { cwd: join(root, 'backend'), encoding: 'utf8', windowsHide: true, maxBuffer: 4000000 }); const results = JSON.parse(stdout.replace(/^\uFEFF/, '')); assert(results.every(result => result.success)); return results.flatMap(result => result.results); }
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers(request.headers); headers.set('Cookie', fixture.cookie); headers.set('Origin', fixture.origin); headers.delete('host'); headers.delete('content-length'); headers.delete('connection');
      const result = await fetch(fixture.origin + url.pathname + url.search, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      response.statusCode = result.status;
      for (const [name, value] of result.headers) if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name)) response.setHeader(name, value);
      response.setHeader('Cache-Control', 'no-store'); response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    const target = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    assert(target.startsWith(dist + '/') || target.startsWith(dist + '\\') || target === dist);
    let file = target; try { if (!(await stat(file)).isFile()) file = join(dist, 'index.html'); } catch { file = join(dist, 'index.html'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.tgz': 'application/gzip' };
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); response.setHeader('Cache-Control', 'no-store'); response.end(await readFile(file));
  } catch { response.statusCode = 500; response.end('Local browser fixture failed'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5290, '127.0.0.1', resolve); });
async function browser(...args) {
  // Windows CLI daemons can inherit pipe handles; wait for the CLI process exit,
  // writing output to an ignored file rather than waiting for daemon pipe closure.
  const output = join(out, `cli-${randomUUID()}.txt`); const file = await open(output, 'w');
  const child = spawn(process.execPath, [npx, '--yes', 'agent-browser', '--session', sessionName, ...args], { windowsHide: true, stdio: ['ignore', file.fd, file.fd] });
  let timer; const code = await new Promise((resolve, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error(`Browser command timed out: ${args[0]}`)); }, 60000); child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  await file.close(); const stdout = await readFile(output, 'utf8'); assert.equal(code, 0, `${args[0]}: ${stdout}`); return stdout;
}
async function snapshot() { return await browser('snapshot'); }
async function byName(role, name, action = 'click') { const current = await snapshot(); const line = current.split('\n').find(line => line.includes(`- ${role} "${name}"`)); assert(line, `No ${role} ${name}`); const ref = line.match(/ref=(e\d+)/)?.[1]; assert(ref, `Missing ref for ${name}`); return await browser(action, `@${ref}`); }
async function evaluateJSON(source) { const result = JSON.parse((await browser('eval', source)).trim()); return typeof result === 'string' ? JSON.parse(result) : result; }
async function awaitText(text) { let last; for (let attempt = 0; attempt < 15; attempt++) { last = await snapshot(); if (last.includes(text)) return last; await new Promise(resolve => setTimeout(resolve, 300)); } throw new Error(`Browser did not display ${text}: ${last}`); }
async function api(path) { const result = await fetch(origin + '/api/v1/agent-bridges' + path); assert(result.ok, `Local API ${path} failed: ${result.status}`); return (await result.json()).data; }
let modelCalls = 0, prompts = 0, handoff, pair, finalSnapshot;
try {
  // Seeded verdict is authoritative test data; enabling this test config dispatches no model.
  query('UPDATE ai_config_versions SET enabled=1;');
  const { Journal, CloudClient, BridgeRunner } = await import(pathToFileURL(join(root, 'packages/dsh-team-office-bridge/src/runner.js')).href);
  const secret = randomBytes(32).toString('hex');
  const cloud = new CloudClient('https://browser-fixture.invalid/api/v1/agent-bridges', secret, (url, options) => fetch(fixture.origin + new URL(url).pathname, options));
  pair = await cloud.request('pairings', 'POST', { credentialHash: sha(secret), deviceName: 'Browser QA DSH', bridgeVersion: '0.1.0', dshVersion: '0.2.0-rc.2' });
  await browser('open', `${origin}/app/agent-bridges/connect?pairing=${pair.pairingId}`);
  await awaitText('确认连接并授权项目');
  await byName('checkbox', 'Local bridge fixture', 'check');
  await byName('button', '确认连接并授权项目');
  await awaitText('连接已授权'); await browser('screenshot', join(out, 'pairing-approved.png'));
  await cloud.request('device/workspaces', 'POST', { projectId: fixture.projectId, workspaceLabel: 'Browser QA' });
  await browser('open', `${origin}/app/settings/agent-bridges`); await awaitText('已绑定工作目录');
  await browser('screenshot', join(out, 'device-bound.png'));
  await browser('open', `${origin}/app/projects/${fixture.projectId}/tasks`); await awaitText('交给本地 Agent');
  await byName('button', '交给本地 Agent');
  await awaitText('等待 DSH 接收'); await browser('screenshot', join(out, 'waiting-device.png'));
  handoff = (await api(`/projects/${fixture.projectId}/tasks/${fixture.taskId}/handoffs`)).items[0]; assert(handoff);
  const journal = await new Journal(join(out, randomUUID())).load(); const workspace = join(out, 'workspace', randomUUID()); await mkdir(workspace, { recursive: true }); journal.state.bindings[fixture.projectId] = { cwd: workspace, label: 'Browser QA' }; await journal.save();
  let completion, events = [];
  const dsh = { create: async (_run, callback) => { completion = callback; }, attach: async () => {}, prompt: async run => { prompts++; await writeFile(join(run.output, 'browser-report.txt'), 'Actual browser test result\n'); await completion({ summary: '浏览器验收成果说明：已有资料分析完成', paths: ['browser-report.txt'] }); events = [{ seq: 1, type: 'user/message', data: { source: { rpcId: run.id } } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } }]; return { accepted: true }; }, inspect: async () => ({ events }), isLive: () => true, cancel: async () => {}, release: () => {} };
  const runner = new BridgeRunner({ journal, client: cloud, dsh }); for (let index = 0; index < 5; index++) { await runner.tick(); if (journal.state.runs[handoff.handoffId]?.state === 'ready_for_review') break; }
  await awaitText('成果草稿待核对'); await browser('screenshot', join(out, 'draft-before-review.png'));
  const ready = await api(`/handoffs/${handoff.handoffId}`); assert.equal(ready.state, 'ready_for_review'); assert.equal(ready.result.artifacts.length, 1); assert.equal(prompts, 1);
  const before = await evaluateJSON(`JSON.stringify({disabled:Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='采纳并提交验收').disabled,overflow:document.documentElement.scrollWidth>innerWidth})`); assert.equal(before.disabled, true);
  query('UPDATE ai_config_versions SET enabled=0;');
  await byName('checkbox', '我已核对成果说明及文件', 'check');
  await byName('button', '采纳并提交验收');
  finalSnapshot = await awaitText('已提交验收'); await browser('screenshot', join(out, 'submitted.png'));
  assert.equal(query(`SELECT COUNT(*) n FROM task_submissions WHERE task_id=${q(fixture.taskId)}`)[0].n, 1);
  modelCalls = query(`SELECT COUNT(*) n FROM ai_tool_calls WHERE project_id=${q(fixture.projectId)}`)[0].n; assert.equal(modelCalls, 0);
  await browser('set', 'viewport', '390', '844'); await browser('open', `${origin}/app/settings/agent-bridges`); await awaitText('已绑定工作目录');
  await browser('screenshot', join(out, 'mobile-settings.png'));
  const geometry = await evaluateJSON('JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth})'); assert.equal(geometry.overflow, false, JSON.stringify(geometry));
  await writeFile(join(out, 'report.json'), JSON.stringify({ passed: true, browser: 'agent-browser Chromium', backend: 'real local Workers/D1/R2', actualPluginRunner: true, dshAdapter: 'simulated', production: false, modelCalls, prompts, projectId: fixture.projectId, taskId: fixture.taskId, handoffId: handoff.handoffId, checks: ['actual browser pairing approval', 'actual device directory binding display', 'one click website dispatch', 'actual runner claim and artifact upload', 'unchecked review disabled', 'manual review adoption submits once', 'mobile settings no horizontal overflow'], geometry, finalSnapshot }, null, 2));
  console.log(JSON.stringify({ passed: true, report: join(out, 'report.json'), modelCalls, prompts }));
} finally { await browser('close').catch(() => {}); await new Promise(resolve => server.close(resolve)); }
