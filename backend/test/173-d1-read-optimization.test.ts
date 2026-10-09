import { expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { recordAiDiagnostic } from '../src/ai/diagnostics';

const oldTrim = `DELETE FROM ai_diagnostics WHERE id IN (
  SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS entry_rank,
    SUM(byte_size) OVER (ORDER BY id DESC ROWS UNBOUNDED PRECEDING) AS newest_bytes FROM ai_diagnostics)
  WHERE entry_rank > 1000 OR newest_bytes > 999488)`;

async function counters() {
  const actual = await env.DB.prepare('SELECT COUNT(*) AS entry_count, COALESCE(SUM(byte_size),0) AS byte_count FROM ai_diagnostics').first();
  expect(await env.DB.prepare('SELECT entry_count, byte_count FROM ai_diagnostic_retention WHERE id=1').first()).toEqual(actual);
}

it('matches the old newest suffix for count, byte, UTF-8, empty and oversized boundaries', async () => {
  for (const [count, padding] of [[0, 0], [1005, 20], [125, 9000], [3, 1_000_000], [1500, 700]] as const) {
    await env.DB.prepare('DELETE FROM ai_diagnostics').run();
    if (count) {
      const json = JSON.stringify({ padding: '中'.repeat(padding) });
      await env.DB.prepare('WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value < ?1) INSERT INTO ai_diagnostics(entry_json,byte_size) SELECT ?2,?3 FROM n')
        .bind(count, json, new TextEncoder().encode(json).byteLength + 1).run();
    }
    const initial = await env.DB.prepare('SELECT * FROM ai_diagnostics ORDER BY id').all<{ id: number; entry_json: string; byte_size: number }>();
    expect(await recordAiDiagnostic(env, { operation: 'config_read', phase: 'snapshot_loaded', status: 'succeeded', durationMs: 0, errorCode: 'NONE' })).toBe(true);
    const added = await env.DB.prepare('SELECT * FROM ai_diagnostics ORDER BY id DESC LIMIT 1').first<{ id: number; entry_json: string; byte_size: number }>();
    const retained = await env.DB.prepare('SELECT id FROM ai_diagnostics ORDER BY id').all();
    await env.DB.prepare('DELETE FROM ai_diagnostics').run();
    const originalRows = [...initial.results, added!];
    for (let offset = 0; offset < originalRows.length; offset += 100) {
      await env.DB.batch(originalRows.slice(offset, offset + 100).map(row => env.DB.prepare('INSERT INTO ai_diagnostics(id,entry_json,byte_size) VALUES (?1,?2,?3)').bind(row.id, row.entry_json, row.byte_size)));
    }
    await env.DB.prepare(oldTrim).run();
    expect((await env.DB.prepare('SELECT id FROM ai_diagnostics ORDER BY id').all()).results).toEqual(retained.results);
    await counters();
  }
}, 60_000);

it('maintains counters on byte updates, administrator deletion and failed atomic writes', async () => {
  await env.DB.prepare('DELETE FROM ai_diagnostics').run();
  await counters();
  await env.DB.prepare("INSERT INTO ai_diagnostics(entry_json,byte_size) VALUES ('{}',3)").run();
  const replacement = JSON.stringify({ reason: '中文' });
  await env.DB.prepare('UPDATE ai_diagnostics SET entry_json=?1,byte_size=?2').bind(replacement, new TextEncoder().encode(replacement).byteLength + 1).run();
  await counters();
  const before = await env.DB.prepare('SELECT * FROM ai_diagnostic_retention').first();
  await expect(env.DB.batch([
    env.DB.prepare("INSERT INTO ai_diagnostics(entry_json,byte_size) VALUES ('{}',3)"),
    env.DB.prepare("INSERT INTO ai_diagnostics(entry_json,byte_size) VALUES ('{}',999)"),
  ])).rejects.toThrow();
  expect(await env.DB.prepare('SELECT * FROM ai_diagnostic_retention').first()).toEqual(before);
  await counters();
  await env.DB.prepare('DELETE FROM ai_diagnostics').run();
  await counters();
  await env.DB.prepare("INSERT INTO ai_diagnostics(entry_json,byte_size) VALUES ('{}',3)").run();
  await counters();
});

it('uses partial job indexes without full table scans or temporary sorts', async () => {
  const reservations = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM usage_reservations WHERE job_id=?1 AND status='reserved' ORDER BY created_at DESC LIMIT 1").bind('missing-job').all<{ detail: string }>();
  expect(reservations.results.map(row => row.detail).join(' ')).toContain('idx_reservations_active_job_created');
  expect(reservations.results.map(row => row.detail).join(' ')).not.toMatch(/SCAN usage_reservations|TEMP B-TREE/);
  const calls = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT id FROM ai_calls WHERE job_id=?1 LIMIT 1').bind('missing-job').all<{ detail: string }>();
  expect(calls.results.map(row => row.detail).join(' ')).toContain('idx_ai_calls_job');
  expect(calls.results.map(row => row.detail).join(' ')).not.toContain('SCAN ai_calls');
});

it('keeps latest reserved-attempt semantics through settlement and release', async () => {
  const projectId = await seedProject((await seedUser()).userId);
  for (const [id, status, date] of [['old', 'reserved', '2026-10-01'], ['latest', 'reserved', '2026-10-03'], ['settled', 'settled', '2026-10-04']] as const) {
    await env.DB.prepare('INSERT INTO usage_reservations(id,project_id,job_id,purpose,status,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(id, projectId, 'job-under-test', 'textEconomy', status, date).run();
  }
  const latest = () => env.DB.prepare("SELECT id FROM usage_reservations WHERE job_id=?1 AND status='reserved' ORDER BY created_at DESC LIMIT 1").bind('job-under-test').first();
  expect(await latest()).toEqual({ id: 'latest' });
  await env.DB.prepare("UPDATE usage_reservations SET status='released' WHERE id='latest'").run();
  expect(await latest()).toEqual({ id: 'old' });
  await env.DB.prepare("UPDATE usage_reservations SET status='settled' WHERE id='old'").run();
  expect(await latest()).toBeNull();
});
