import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://greenbp-team-office.hddhp.workers.dev';
const html = await readFile(path.join(root, 'frontend/dist/index.html'), 'utf8');
const script = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
assert.ok(script, 'Build frontend first');
const fetchChecked = async route => fetch(origin + route, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
const page = await fetchChecked('/');
assert.equal(page.status, 200); assert.ok((await page.text()).includes(script), 'Online shell must reference this build');
const asset = await fetchChecked(script);
assert.equal(asset.status, 200);
const code = await asset.text();
// Vite can move bridge code into a shared chunk. Verify its published bytes too,
// rather than assuming all native commands live in the entry module.
const assetsDirectory = path.join(root, 'frontend/dist/assets');
const chunks = await Promise.all((await readdir(assetsDirectory)).filter(name => name.endsWith('.js')).map(async name => ({ name, code: await readFile(path.join(assetsDirectory, name), 'utf8') })));
const verifiedChunks = new Set();
for (const command of ['desktop_hello', 'desktop_report_state', 'desktop_set_auto_restart']) {
  if (code.includes(command)) continue;
  const chunk = chunks.find(item => item.code.includes(command));
  assert.ok(chunk, 'Missing native command in build: ' + command);
  if (!verifiedChunks.has(chunk.name)) {
    const published = await fetchChecked('/assets/' + chunk.name);
    assert.equal(published.status, 200);
    assert.equal(await published.text(), chunk.code, 'Published bridge chunk differs: ' + chunk.name);
    verifiedChunks.add(chunk.name);
  }
}
const session = await fetchChecked('/api/v1/auth/session'); assert.equal(session.status, 401, 'Anonymous access must remain rejected');
const capabilities = await fetchChecked('/api/v1/capabilities'); assert.equal(capabilities.status, 200);
const value = await capabilities.json(); assert.equal(value.data.environment, 'production'); assert.equal(value.data.authentication.passwordEnabled, true);
const output = path.join(root, 'output/windows-client'); await mkdir(output, { recursive: true });
const report = { passed: true, checkedAt: new Date().toISOString(), origin, script, checks: ['online build matches local compiled entry', 'native bridge commands published', 'anonymous session rejected', 'existing password production API available'], paidModelCalls: 0 };
await writeFile(path.join(output, 'web-deployment.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
