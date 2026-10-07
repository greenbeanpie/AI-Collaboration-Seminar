import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateMigrations } from '../lib/migration-policy.mjs';
import { containsSecret } from '../lib/secret-patterns.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const baseline = { '0025_one.sql': hash('a'), '0025_two.sql': hash('b'), '0060_last.sql': hash('c') };
const existing = () => new Map([['0025_one.sql', 'a'], ['0025_two.sql', 'b'], ['0060_last.sql', 'c']]);
test('preserves historical duplicate numbers and accepts new sequential migrations', () => {
  const files = existing(); files.set('0061_next.sql', 'd'); files.set('0062_next.sql', 'e');
  assert.deepEqual(validateMigrations(files, baseline), []);
});
test('rejects modification/removal of published migrations and reused numbers', () => {
  const files = existing(); files.delete('0025_one.sql'); files.set('0025_two.sql', 'changed'); files.set('0059_added.sql', 'x'); files.set('0061_one.sql', 'x'); files.set('0061_two.sql', 'x');
  assert.equal(validateMigrations(files, baseline).length, 4);
});
test('secret scan identifies credentials without accepting short examples', () => {
  assert.equal(containsSecret('ghp_' + 'a'.repeat(36)), true);
  assert.equal(containsSecret('-----BEGIN ' + 'PRIVATE KEY-----'), true);
  assert.equal(containsSecret('sk-example or ghp_example'), false);
});

test('CI has read-only verification, contract drift checks, build identity and no deploy', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const command of ['install:all', 'test:engineering', 'check:secrets', 'check:migrations', 'typecheck', 'lint', 'test:backend', 'test:frontend', 'export:openapi', 'typegen', 'verify:reproducible-build', 'preflight:deploy']) assert.ok(yaml.includes(command), `Missing CI check: ${command}`);
  assert.match(yaml, /git diff --exit-code/);
  assert.match(yaml, /contents: read/);
  assert.doesNotMatch(yaml, /contents: write|secrets\./);
  assert.match(yaml, /VITE_BUILD_VERSION: \$\{\{ github\.sha \}\}/);
  const deployLines = yaml.split('\n').filter(line => line.includes('wrangler deploy'));
  assert.equal(deployLines.length, 2);
  assert.ok(deployLines.every(line => line.includes('--dry-run')));
});
