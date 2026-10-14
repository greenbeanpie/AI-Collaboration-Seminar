import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
const version = process.env.VITE_BUILD_VERSION;
if (!/^[0-9a-f]{7,40}$/.test(version ?? '')) throw new Error('Set VITE_BUILD_VERSION to the Git commit SHA.');
const root = new URL('../', import.meta.url);
const dist = new URL('../frontend/dist/', import.meta.url);
function snapshot(directory, prefix = '') {
  const hashes = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(hashes, snapshot(path, `${relative}/`));
    else hashes[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return hashes;
}
function build() {
  const directory=fileURLToPath(dist),workspace=fileURLToPath(root);
  if(!resolve(directory).startsWith(resolve(workspace)+sep))throw new Error('Build directory must stay inside the workspace');
  rmSync(directory, { recursive: true, force: true });
  execFileSync(process.execPath, [process.env.npm_execpath ?? join(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js'), 'run', 'build', '--prefix', 'frontend'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_BUILD_VERSION: version } });
  return snapshot(fileURLToPath(dist));
}
const first = build();
const second = build();
const differing = [...new Set([...Object.keys(first), ...Object.keys(second)])].filter(path => first[path] !== second[path]);
if (differing.length) throw new Error(`Build differs: ${differing.join(', ')}`);
console.log(`PASS: ${Object.keys(first).length} artifact SHA-256 hashes match for ${version}.`);
