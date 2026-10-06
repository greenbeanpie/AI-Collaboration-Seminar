import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { containsSecret } from './lib/secret-patterns.mjs';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const flagged = [];
for (const path of paths) {
  let bytes;
  try { bytes = readFileSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (bytes.includes(0)) continue;
  if (containsSecret(bytes.toString('utf8'))) flagged.push(path);
}
if (flagged.length) { console.error(`Potential secrets in tracked files (values withheld):\n${flagged.join('\n')}`); process.exitCode = 1; }
else console.log(`PASS: scanned ${paths.length} tracked files for private keys and common credential formats.`);
