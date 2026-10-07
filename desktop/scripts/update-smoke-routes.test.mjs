import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateSmokeHandler } from './update-smoke-routes.mjs';
test('smoke manifest and exact installer route; arbitrary paths are not served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buwei-update-http-'));
  const installerPath = join(dir, 'test.exe');
  writeFileSync(installerPath, 'signed installer test bytes'); writeFileSync(`${installerPath}.sig`, 'test-signature');
  const handle = createUpdateSmokeHandler({ installerPath });
  const server = createServer(async (req, res) => { if (!await handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = await (await fetch(`${origin}/latest.json`)).json();
    assert.equal(manifest.version, '0.1.1'); assert.equal(manifest.platforms['windows-x86_64'].signature, 'test-signature');
    assert.equal(manifest.platforms['windows-x86_64'].url, 'http://127.0.0.1:5173/updates/test.exe');
    assert.equal(await (await fetch(`${origin}/updates/test.exe`)).text(), 'signed installer test bytes');
    assert.equal((await fetch(`${origin}/updates/other.exe`)).status, 404);
    assert.equal((await fetch(`${origin}/latest.json`, { method: 'POST' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
