import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults to a read-only preview against the local database. Never deploys migrations.
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const remote = args.includes('--remote');
const environment = args.includes('--env') ? args[args.indexOf('--env') + 1] : undefined;
const backup = args.includes('--backup-file') ? args[args.indexOf('--backup-file') + 1] : undefined;
const allowed = new Set(['--apply', '--remote', '--local', '--env', '--backup-file', environment, backup]);
if (args.some(arg => !allowed.has(arg)) || (environment && !['staging', 'production'].includes(environment)) || (remote && !environment)) {
  throw new Error('Usage: node scripts/backfill-system-background.mjs [--local | --remote --env staging|production] [--apply] [--backup-file path]');
}
if (remote && apply && (!backup || !existsSync(backup))) throw new Error('Remote apply requires an existing backup file via --backup-file. Run preview first.');
const backend = fileURLToPath(new URL('../backend', import.meta.url));
const cli = join(backend, 'node_modules/wrangler/bin/wrangler.js');
const prefix = ['d1', 'execute', 'DB', remote ? '--remote' : '--local', ...(environment ? ['--env', environment] : []), '--json'];
const execute = extra => execFileSync(process.execPath, [cli, ...prefix, ...extra], { cwd: backend, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const preview = `SELECT p.id,p.name,CASE WHEN m.id IS NULL THEN 'generate' ELSE 'already_present' END action
 FROM projects p LEFT JOIN materials m ON m.project_id=p.id AND m.system_managed=1 ORDER BY p.id`;
process.stdout.write(execute(['--command', preview]));
if (apply) {
  const directory = mkdtempSync(join(tmpdir(), 'system-background-'));
  try {
    const file = join(directory, 'backfill.sql');
    writeFileSync(file, `INSERT OR IGNORE INTO project_goals(project_id,title,detail,created_at,updated_at)
 SELECT id,name,description,created_at,updated_at FROM projects;
 UPDATE project_goals SET title=title;
 SELECT COUNT(*) systemBackgrounds FROM materials WHERE system_managed=1;`, 'utf8');
    process.stdout.write(execute(['--file', file]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
