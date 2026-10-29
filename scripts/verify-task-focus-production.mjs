// Read-only production verification. Authentication is the only POST; no model calls.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const origin = process.env.RELEASE_URL || 'https://team.greenbp.dpdns.org';
assert(['https://team.greenbp.dpdns.org', 'https://greenbp-team-office.hddhp.workers.dev'].includes(origin));
const output = resolve('output/verification/task-focus');
await mkdir(output, { recursive: true });
const report = { origin, checkedAt: new Date().toISOString(), checks: [], limitations: [], passed: false, modelCalls: 0 };
let cookie;
async function get(path, authenticated = true) {
  const response = await fetch(origin + '/api/v1' + path, { headers: authenticated && cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `GET ${path}: ${response.status}`);
  return (await response.json()).data;
}
try {
  assert.equal((await get('/health', false)).status, 'ok');
  report.checks.push('production health');
  const html = await readFile('frontend/dist/index.html', 'utf8');
  const asset = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  assert(asset);
  const remoteHtml = await fetch(origin + '/', { signal: AbortSignal.timeout(30000) });
  assert.equal(remoteHtml.status, 200);
  assert((await remoteHtml.text()).includes(asset), 'deployed entry differs from release build');
  const response = await fetch(origin + asset, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile('frontend/dist' + asset)));
  report.checks.push('deployed entry and SHA256 match local build');
  const anonymous = await fetch(origin + '/api/v1/projects/00000000-0000-4000-8000-000000000001/tasks/focus');
  assert.equal(anonymous.status, 401);
  report.checks.push('anonymous focus access rejected');
  const credentialFile = process.env.RELEASE_CREDENTIALS_FILE;
  if (!credentialFile) report.limitations.push('Authenticated verification not run: RELEASE_CREDENTIALS_FILE absent');
  else {
    const saved = JSON.parse(await readFile(credentialFile, 'utf8'));
    for (const account of [saved.acceptanceAccounts?.at(-1), saved.accounts?.production].filter(Boolean)) {
      const login = await fetch(origin + '/api/v1/auth/sessions', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ account: account.username, password: account.password }), signal: AbortSignal.timeout(30000) });
      if (login.status !== 201) { report.limitations.push(`Existing account login rejected (${login.status}); credentials unchanged`); continue; }
      cookie = login.headers.get('set-cookie')?.split(';')[0];
      if (cookie) break;
    }
    if (cookie) {
      const projects = await get('/projects?status=all&limit=100');
      let checked = 0;
      for (const project of projects.items.slice(0, 5)) {
        const base = `/projects/${encodeURIComponent(project.id ?? project.projectId)}/tasks`;
        const [focus, graph] = await Promise.all([get(base + '/focus'), get(base + '/graph')]);
        assert(Array.isArray(graph.items));
        for (const group of ['items', 'waitingReview', 'reviewRequired']) {
          assert(Array.isArray(focus[group]));
          for (const task of focus[group]) { assert(Array.isArray(task.focusReasons)); assert.equal(typeof task.pinned, 'boolean'); }
        }
        for (const task of graph.items) {
          assert(task.parentTaskId === null || typeof task.parentTaskId === 'string');
          assert(Array.isArray(task.manualDependsOnTaskIds));
          if (task.parentTaskId) assert(graph.items.find(parent => parent.taskId === task.parentTaskId)?.dependsOnTaskIds.includes(task.taskId));
        }
        checked++;
      }
      report.checks.push(`authenticated graph and focus contracts: ${checked} projects`);
      if (!checked) report.limitations.push('Authenticated account has no projects');
    } else report.limitations.push('Authenticated task data remains unverified');
  }
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
await writeFile(resolve(output, 'production.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
