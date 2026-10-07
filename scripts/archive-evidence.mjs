import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../docs/evidence-archive-manifest.json', import.meta.url), 'utf8'));
const target = resolve(process.argv[3] ?? manifest.archiveDirectory);
const mode = process.argv[2];
if (!['--archive', '--verify'].includes(mode)) throw new Error('Usage: node scripts/archive-evidence.mjs --archive|--verify [archive directory]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const entry of manifest.files) {
  const source = resolve(root, entry.path);
  const archived = resolve(target, entry.path);
  if (!source.startsWith(root) || !archived.startsWith(target + sep)) throw new Error(`Unsafe path: ${entry.path}`);
  if (mode === '--archive') {
    let exists = false;
    try {
      const bytes = readFileSync(archived);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Existing archive mismatch: ${entry.path}`);
      exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Never replace an existing verified baseline archive with newer reports.
    if (!exists) {
      const bytes = readFileSync(source);
      if (hash(bytes) !== entry.sha256) throw new Error(`Source mismatch: ${entry.path}`);
      mkdirSync(dirname(archived), { recursive: true });
      copyFileSync(source, archived);
    }
  }
  const bytes = readFileSync(archived);
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Archive mismatch: ${entry.path}`);
}
if (mode === '--archive') {
  copyFileSync(new URL('../docs/evidence-archive-manifest.json', import.meta.url), resolve(target, 'manifest.json'));
  copyFileSync(new URL('../docs/EVIDENCE-ARCHIVE.md', import.meta.url), resolve(target, 'RECOVERY.md'));
}
console.log(`PASS: ${manifest.files.length} archived files verified by size and SHA-256 in ${target}`);
