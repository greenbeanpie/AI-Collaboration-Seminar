// Read-only release verification. No login, writes, or model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const origin = 'https://greenbp-team-office.hddhp.workers.dev';
const dist = new URL('../frontend/dist/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const index = await readFile(new URL('index.html', dist));
const mainAsset = /src="(\/assets\/index-[^"]+\.js)"/.exec(index.toString())[1];
const mainStyles = /href="(\/assets\/index-[^"]+\.css)"/.exec(index.toString())[1];
const assetNames = await readdir(new URL('assets/', dist));
const menuAssets = [];
for (const name of assetNames.filter(name => /\.(js|css)$/.test(name))) {
  if ((await readFile(new URL('assets/' + name, dist), 'utf8')).includes('--dropdown-offset')) menuAssets.push('/assets/' + name);
}
assert(menuAssets.length >= 2, 'build must contain the dropdown positioning JS and CSS');
const paths = [...new Set(['/app/help', '/app/help?doc=technical', '/app/help?doc=database', mainAsset, mainStyles, ...assetNames.filter(name => /^HelpPage-.*\.(js|css)$/.test(name)).map(name => '/assets/' + name), ...menuAssets])];
const results = await Promise.all(paths.map(async pathname => {
  const response = await fetch(origin + pathname, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, pathname);
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = pathname.startsWith('/app/help') ? index : await readFile(new URL(pathname.slice(1), dist));
  assert.equal(hash(actual), hash(expected), `deployed bytes differ: ${pathname}`);
  return { path: pathname, status: response.status, sha256: hash(actual), matchesBuild: true };
}));
const session = await fetch(origin + '/api/v1/auth/session', { signal: AbortSignal.timeout(30000) });
assert.equal(session.status, 401);
assert.equal((await session.json()).error.code, 'UNAUTHENTICATED');
results.push({ path: '/api/v1/auth/session', status: session.status, anonymous: true });
const health = await fetch(origin + '/api/v1/health', { signal: AbortSignal.timeout(30000) });
assert.equal(health.status, 200);
results.push({ path: '/api/v1/health', status: health.status });
const report = { verifiedAt: new Date().toISOString(), origin, versionId: process.argv[2] ?? null, results, boundary: 'Static release bytes and anonymous service checks; authenticated production reading requires a valid existing session. Local browser fixtures verify member routing and document interactions. No production write or model invocation.' };
await writeFile(process.env.HELP_VERIFICATION_OUTPUT ?? new URL('../docs/evidence/help/production-verification.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
