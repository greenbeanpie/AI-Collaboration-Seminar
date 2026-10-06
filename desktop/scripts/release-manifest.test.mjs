import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifest } from './release-manifest.mjs';
test('manifest binds both Windows targets to versioned signed installer', () => {
  const m = manifest('0.1.0', 'BuWei_0.1.0_x64-setup.exe', 'signature\n');
  assert.equal(m.platforms['windows-x86_64'].signature, 'signature');
  assert.match(m.platforms['windows-x86_64-nsis'].url, /desktop-v0\.1\.0/);
});
test('reject invalid version or unsigned artifact', () => {
  assert.throws(() => manifest('../../main', 'app.exe', 'sig'));
  assert.throws(() => manifest('1.0.0', 'app.msi', 'sig'));
  assert.throws(() => manifest('1.0.0', 'app.exe', ''));
});
