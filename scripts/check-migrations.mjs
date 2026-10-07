import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateMigrations } from './lib/migration-policy.mjs';
const dir = new URL('../backend/migrations/', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('./migrations-baseline.json', import.meta.url), 'utf8'));
const files = new Map(readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => [name, readFileSync(new URL(name, dir))]));
const problems = validateMigrations(files, baseline.files);
// Optional PR base adds protection for migrations published after the initial baseline.
const baseRef = process.argv[2];
if (baseRef) {
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', baseRef, '--', 'backend/migrations'], { encoding: 'utf8' }).trim().split('\n').filter(name => name.endsWith('.sql'));
  const published = Object.fromEntries(paths.map(path => [path.split('/').at(-1), createHash('sha256').update(execFileSync('git', ['show', `${baseRef}:${path}`])).digest('hex')]));
  problems.push(...validateMigrations(files, published));
  const path = 'scripts/migrations-baseline.json';
  const old = execFileSync('git', ['ls-tree', '--name-only', baseRef, '--', path], { encoding: 'utf8' }).trim();
  if (old && execFileSync('git', ['show', `${baseRef}:${path}`], { encoding: 'utf8' }) !== readFileSync(new URL('./migrations-baseline.json', import.meta.url), 'utf8')) problems.push('Baseline manifest is immutable');
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${files.size} migrations; historical duplicate 0025 preserved; new numbers unique and increasing.`);
