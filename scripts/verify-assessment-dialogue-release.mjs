import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Read-only production checks: no session creation, model call or scoring mutation.
const base = process.env.VERIFY_BASE_URL ?? 'https://greenbp-team-office.hddhp.workers.dev';
const checks = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const path of ['/api/v1/health', '/api/v1/health/deps']) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, path);
  checks.push({ path, status: 200, body: await response.json() });
}
const files = await readdir('frontend/dist/assets');
const assets = files.filter(name => /^(index-|AssessmentWorkspacePage-)/.test(name) && /\.(js|css)$/.test(name));
assert(assets.some(name => /^AssessmentWorkspacePage-.*\.js$/.test(name)), 'Assessment page build is present');
for (const path of ['index.html', ...assets.map(name => 'assets/' + name)]) {
  const bytes = await readFile('frontend/dist/' + path);
  const response = await fetch(base + '/' + (path === 'index.html' ? '' : path), { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, path);
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(bytes), path);
  checks.push({ path, status: 200, sha256: hash(bytes), matchesLocalBuild: true });
}
const route = '/api/v1/projects/00000000-0000-4000-8000-000000000001/assessments/00000000-0000-4000-8000-000000000002/followups';
const denied = await fetch(base + route, { signal: AbortSignal.timeout(20000) });
assert.equal(denied.status, 401, 'Follow-up history requires authentication');
checks.push({ path: 'followup-authentication', status: 401 });
await mkdir('output', { recursive: true });
await writeFile('output/assessment-dialogue-http.json', JSON.stringify({ base, checks, browserTesting: false, productionModelCalls: 0 }, null, 2));
console.log(JSON.stringify({ httpChecksPassed: checks.length, assetsMatch: true, browserTesting: false, productionModelCalls: 0 }));
