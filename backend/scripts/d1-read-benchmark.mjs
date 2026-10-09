import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const base = new URL('../', import.meta.url);
const migration = await readFile(new URL('migrations/0069_d1_read_optimization.sql', base), 'utf8');
const source = await readFile(new URL('src/ai/diagnostics.ts', base), 'utf8');
const trimTemplate = source.match(/const trimSql = `([\s\S]*?)`;/)?.[1];
if (!trimTemplate) throw new Error('Cannot find production diagnostics retention SQL');
const newTrim = trimTemplate.replace('${MAX_DIAGNOSTIC_ENTRIES}', '1000').replace('${MAX_DIAGNOSTIC_BYTES - 512}', '999488');
const oldTrim = `DELETE FROM ai_diagnostics WHERE id IN (
  SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS entry_rank,
    SUM(byte_size) OVER (ORDER BY id DESC ROWS UNBOUNDED PRECEDING) AS newest_bytes FROM ai_diagnostics)
  WHERE entry_rank > 1000 OR newest_bytes > 999488)`;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("benchmark"); } }',
  compatibilityDate: '2026-10-05', d1Databases: { DB: 'benchmark' } }));
const db = await runtime.getD1Database('DB');
const report = { runtime: 'local Miniflare D1; synthetic data; no provider requests', cases: [] };

async function measure(label, action) {
  const started = performance.now();
  const results = await action();
  const records = Array.isArray(results) ? results : [results];
  report.cases.push({ label, statements: records.length, rows_read: records.reduce((total, result) => total + result.meta.rows_read, 0),
    rows_written: records.reduce((total, result) => total + result.meta.rows_written, 0), elapsed_ms: Number((performance.now() - started).toFixed(3)) });
}

async function seedDiagnostics() {
  await db.prepare('DELETE FROM ai_diagnostics').run();
  await db.prepare("WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000) INSERT INTO ai_diagnostics(entry_json,byte_size) SELECT '{}',3 FROM n").run();
}

try {
  await db.exec('CREATE TABLE usage_reservations(id TEXT PRIMARY KEY, job_id TEXT, created_at TEXT, status TEXT); CREATE TABLE ai_calls(id TEXT PRIMARY KEY,job_id TEXT); CREATE TABLE ai_diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_json TEXT NOT NULL,byte_size INTEGER NOT NULL CHECK(byte_size=length(CAST(entry_json AS BLOB))+1));');
  await db.prepare("WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<10000) INSERT INTO usage_reservations SELECT CAST(value AS TEXT),'history-'||value,'2026-10-01','settled' FROM n").run();
  await db.prepare("INSERT INTO usage_reservations VALUES ('active','active-job','2026-10-09','reserved')").run();
  await db.prepare('INSERT INTO ai_calls SELECT id,job_id FROM usage_reservations').run();
  await seedDiagnostics();
  await measure('before: idle missing-job reservation + ai-call reads', () => db.batch([
    db.prepare("SELECT id FROM usage_reservations WHERE job_id='missing-job' AND status='reserved' ORDER BY created_at DESC LIMIT 1"),
    db.prepare("SELECT id FROM ai_calls WHERE job_id='missing-job' LIMIT 1"),
  ]));
  await measure('before: reserved + call insertion write cost', () => db.batch([
    db.prepare("INSERT INTO usage_reservations VALUES ('baseline-new','baseline-new-job','2026-10-09','reserved')"),
    db.prepare("INSERT INTO ai_calls VALUES ('baseline-new','baseline-new-job')"),
  ]));
  await measure('before: 100 diagnostic insert + retention transactions', async () => {
    const results = [];
    for (let index = 0; index < 100; index++) results.push(...await db.batch([db.prepare("INSERT INTO ai_diagnostics(entry_json,byte_size) VALUES ('{}',3)"), db.prepare(oldTrim)]));
    return results;
  });
  const triggers = migration.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
  const ordinary = migration.replace(/CREATE TRIGGER[\s\S]*?END;/g, '');
  for (const statement of [...ordinary.split(';').map(sql => sql.trim()).filter(Boolean), ...triggers]) await db.prepare(statement).run();
  const stats = await db.prepare('SELECT entry_count,byte_count FROM ai_diagnostic_retention WHERE id=1').first();
  if (stats.entry_count !== 1000 || stats.byte_count !== 3000) throw new Error('Migration did not preserve existing diagnostics');
  await measure('after: idle missing-job reservation + ai-call reads', () => db.batch([
    db.prepare("SELECT id FROM usage_reservations WHERE job_id='missing-job' AND status='reserved' ORDER BY created_at DESC LIMIT 1"),
    db.prepare("SELECT id FROM ai_calls WHERE job_id='missing-job' LIMIT 1"),
  ]));
  await seedDiagnostics();
  await measure('after: 100 diagnostic insert + retention transactions', async () => {
    const results = [];
    for (let index = 0; index < 100; index++) results.push(...await db.batch([db.prepare("INSERT INTO ai_diagnostics(entry_json,byte_size) VALUES ('{}',3)"), db.prepare(newTrim)]));
    return results;
  });
  await measure('after: index and trigger write cost, reserved + call insertion', () => db.batch([
    db.prepare("INSERT INTO usage_reservations VALUES ('new','new-job','2026-10-09','reserved')"),
    db.prepare("INSERT INTO ai_calls VALUES ('new','new-job')"),
  ]));
  const actual = await db.prepare('SELECT COUNT(*) AS entry_count,SUM(byte_size) AS byte_count FROM ai_diagnostics').first();
  const recorded = await db.prepare('SELECT entry_count,byte_count FROM ai_diagnostic_retention WHERE id=1').first();
  if (JSON.stringify(actual) !== JSON.stringify(recorded)) throw new Error('Retention counter mismatch');
  report.final_retention = recorded;
  report.plans = (await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM usage_reservations WHERE job_id='active-job' AND status='reserved' ORDER BY created_at DESC LIMIT 1").all()).results;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.dispose();
}
