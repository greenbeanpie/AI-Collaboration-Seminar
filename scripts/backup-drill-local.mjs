import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A13 本地备份/恢复演练（零云费用）。
 *
 * 只操作 wrangler 的 --local 状态：
 *   1) 从本地 D1 导出 SQL；
 *   2) 校验导出完整性（建表语句、种子数据、结尾完整）；
 *   3) 导入独立的本地演练库并用查询验证数据确实恢复；
 *   4) 清理临时文件。
 *
 * 不做 --remote 导出，不接触任何云端资源。云端恢复步骤见 backend/docs/DEPLOY.md 第 9 节。
 */
const backendDir = fileURLToPath(new URL('../backend', import.meta.url));
// 直接用 node 执行 wrangler 的 CLI：Windows 下 execFileSync 无法直接 spawn .cmd
const WRANGLER_CLI = join(backendDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const REQUIRED_TABLES = [
  'users', 'projects', 'project_members', 'sources', 'source_versions', 'source_pages',
  'source_fragments', 'requirement_sets', 'requirements', 'rubric_versions', 'tasks',
  'materials', 'material_versions', 'agent_sessions', 'agent_runs', 'reviews', 'rehearsals',
  'events', 'contributions', 'jobs', 'job_outbox', 'idempotency_records',
  'ai_config_versions', 'ai_calls', 'usage_reservations', 'app_config', 'ai_probes',
];

function runWrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_CLI, ...args], {
    cwd: backendDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const work = mkdtempSync(join(tmpdir(), 'ai-office-backup-drill-'));
const dumpPath = join(work, 'local-dump.sql');
const drillConfigPath = join(backendDir, 'wrangler.drill.tmp.jsonc');
let passed = 0;

try {
  console.log('[1/4] 导出本地 D1 ...');
  runWrangler(['d1', 'export', 'DB', '--local', '--output=' + dumpPath]);
  assert(existsSync(dumpPath), '导出文件未生成');
  const dump = readFileSync(dumpPath, 'utf8');
  assert(dump.length > 0, '导出文件为空');
  console.log('      导出 ' + dump.length + ' 字符');

  console.log('[2/4] 校验导出完整性 ...');
  const missing = REQUIRED_TABLES.filter(function (table) {
    return !new RegExp('CREATE TABLE( IF NOT EXISTS)? "?' + table + '"?', 'i').test(dump);
  });
  assert.deepEqual(missing, [], '导出缺少建表语句: ' + missing.join(', '));
  assert(/INSERT INTO/i.test(dump), '导出不含任何 INSERT 数据');
  assert(dump.trimEnd().endsWith(';'), '导出疑似被截断（结尾不是分号）');
  passed += 3;
  console.log('      ' + REQUIRED_TABLES.length + ' 张表建表语句齐全，含 INSERT 数据且结尾完整');

  console.log('[3/4] 导入独立演练库并验证 ...');
  // D1 导出按表名顺序交错输出建表与数据，被引用表可能后建（例如 source_versions 的数据
  // 出现在 ai_config_versions 建表之前），直接导入会报 no such table。恢复时重排为
  // 「先全部建表、再灌数据」，这是通用的 FK-safe 批量恢复做法。
  const rawLines = dump.split(/\r?\n/);
  const creates = [];
  const rest = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^PRAGMA\s/i.test(line)) continue; // 由本脚本统一写入外键开关
    if (/^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW)\b/i.test(line)) {
      const block = [line];
      if (!line.trimEnd().endsWith(';')) {
        let j = i + 1;
        while (j < rawLines.length) {
          block.push(rawLines[j]);
          if (rawLines[j].trim() === ');') break;
          j++;
        }
        i = j;
      }
      creates.push(block.join('\n'));
      continue;
    }
    rest.push(line);
  }
  const restorePath = join(work, 'restore.sql');
  // defer_foreign_keys 在事务内把外键校验推迟到 COMMIT：数据存在自引用/循环
  // （materials.current_version_id ↔ material_versions.material_id），无法靠排序满足。
  writeFileSync(restorePath, ['PRAGMA defer_foreign_keys=TRUE;'].concat(creates, rest).join('\n'));
  console.log('      重排：' + creates.length + ' 条建表语句前置，' + rest.length + ' 行数据随后');

  // 每次演练使用新的本地库 ID，保证从零恢复、可重复执行
  const drillDbId = 'drill-local-' + Date.now();
  writeFileSync(drillConfigPath, JSON.stringify({
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'ai-office-drill',
    d1_databases: [{ binding: 'DB', database_name: 'ai-office-db-drill', database_id: drillDbId, migrations_dir: 'migrations' }],
  }, null, 2));
  runWrangler(['d1', 'execute', 'DB', '--local', '--file=' + restorePath, '--config=' + drillConfigPath]);

  const query = 'SELECT (SELECT COUNT(*) FROM ai_config_versions) AS configs, (SELECT COUNT(*) FROM app_config) AS appConfigs, (SELECT COUNT(*) FROM users) AS users';
  const out = runWrangler(['d1', 'execute', 'DB', '--local', '--config=' + drillConfigPath, '--json', '--command=' + query]);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const row = parsed[0].results[0];
  assert(row.configs >= 1, '演练库缺少种子 AI 配置: ' + JSON.stringify(row));
  assert(row.appConfigs >= 1, '演练库缺少种子 app_config: ' + JSON.stringify(row));
  passed += 3;
  console.log('      恢复后行数: ' + JSON.stringify(row));

  console.log('[4/4] 清理临时文件 ...');
  rmSync(work, { recursive: true, force: true });
  rmSync(drillConfigPath, { force: true });
  console.log('PASS: 本地备份/恢复演练 ' + passed + ' 项检查通过（仅使用 --local 状态，未访问云端）');
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  rmSync(drillConfigPath, { force: true });
  console.error('FAIL: 本地备份/恢复演练未通过');
  console.error(error && error.stderr ? String(error.stderr).slice(-4000) : error);
  process.exitCode = 1;
}
