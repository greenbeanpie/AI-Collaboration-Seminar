import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function manifest(version, artifact, signature, notes = '') {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid semver version');
  if (!artifact.endsWith('.exe') || !signature.trim()) throw new Error('Signed NSIS .exe required');
  const platform = { signature: signature.trim(), url: `https://github.com/greenbeanpie/AI-Colleboration-Seminar/releases/download/desktop-v${version}/${encodeURIComponent(basename(artifact))}` };
  return { version, notes, pub_date: new Date().toISOString(), platforms: { 'windows-x86_64': platform, 'windows-x86_64-nsis': platform } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, artifact, output, notesFile] = process.argv.slice(2);
  if (!version || !artifact || !output || !existsSync(artifact)) throw new Error('Usage: node release-manifest.mjs VERSION INSTALLER.exe OUTPUT.json [NOTES.md]');
  writeFileSync(output, JSON.stringify(manifest(version, artifact, readFileSync(`${artifact}.sig`, 'utf8'), notesFile ? readFileSync(notesFile, 'utf8') : ''), null, 2) + '\n');
}
