import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { classifyManagedKey, gcExpiredRecords, gcOrphanObjects } from '../src/services/gc';

const CALL_VALID = crypto.randomUUID();
const CALL_ORPHAN = crypto.randomUUID();
const CALL_FRESH = crypto.randomUUID();
const FILE_VALID = crypto.randomUUID();
const FILE_ORPHAN = crypto.randomUUID();

describe('A13 孤儿对象回收与数据保留', () => {
  it('只删除超过宽限期且数据库无引用的受管对象，dryRun 不落删', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const configRow = await env.DB.prepare('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1')
      .first<{ id: string }>();
    const now = new Date().toISOString();

    // 有引用的 AI 调用快照
    await env.DB.prepare(
      "INSERT INTO ai_calls (id, project_id, purpose, config_version_id, prompt_version, model, status, created_at) VALUES (?1, ?2, 'textEconomy', ?3, 'v1', 'm', 'ok', ?4)",
    ).bind(CALL_VALID, pid, configRow!.id, now).run();
    await env.FILES.put(`ai-calls/${CALL_VALID}/input.json`, '{"a":1}');
    // 有引用的文件对象
    await env.DB.prepare(
      "INSERT INTO files (id, project_id, uploader_user_id, r2_key, mime_declared, ext, status, created_at, original_name) VALUES (?1, ?2, ?3, ?4, 'application/pdf', '.pdf', 'available', ?5, ?6)",
    ).bind(FILE_VALID, pid, owner.userId, `${pid}/${FILE_VALID}.pdf`, now, 'valid.pdf').run();
    await env.FILES.put(`${pid}/${FILE_VALID}.pdf`, 'pdf-bytes');

    // 无引用（孤儿）
    await env.FILES.put(`ai-calls/${CALL_ORPHAN}/input.json`, '{}');
    await env.FILES.put(`${pid}/${FILE_ORPHAN}.pdf`, 'pdf-bytes');
    // 刚写入的孤儿 + 非受管键
    await env.FILES.put(`ai-calls/${CALL_FRESH}/input.json`, '{}');
    await env.FILES.put('misc/keepme.txt', 'keep');

    // 宽限期内的对象一律不删
    const recent = await gcOrphanObjects(env, now);
    expect(recent.deleted).toEqual([]);
    expect(recent.keptRecent).toBeGreaterThanOrEqual(4);
    expect(await env.FILES.head(`ai-calls/${CALL_ORPHAN}/input.json`)).not.toBeNull();

    const expected = [
      `ai-calls/${CALL_FRESH}/input.json`,
      `ai-calls/${CALL_ORPHAN}/input.json`,
      `${pid}/${FILE_ORPHAN}.pdf`,
    ].sort();

    // graceDays=0 时 cutoff = now；对象在 now 之后写入，故需要稍晚的 now 才能判定为「已过宽限期」
    const later = new Date(Date.now() + 60_000).toISOString();

    // dryRun 预演：报告将被删除的对象，但不真正删除
    const dry = await gcOrphanObjects(env, later, { graceDays: 0, dryRun: true });
    expect(dry.deleted.slice().sort()).toEqual(expected);
    expect(await env.FILES.head(`ai-calls/${CALL_ORPHAN}/input.json`)).not.toBeNull();

    // 真实回收
    const result = await gcOrphanObjects(env, later, { graceDays: 0 });
    expect(result.deleted.slice().sort()).toEqual(expected);
    expect(result.failures).toBe(0);
    expect(result.keptReferenced).toBe(2);
    expect(result.skippedUnmanaged).toBe(1);

    // 孤儿已删除
    expect(await env.FILES.head(`ai-calls/${CALL_ORPHAN}/input.json`)).toBeNull();
    expect(await env.FILES.head(`${pid}/${FILE_ORPHAN}.pdf`)).toBeNull();
    // 有效对象与非受管对象不受影响
    expect(await env.FILES.head(`ai-calls/${CALL_VALID}/input.json`)).not.toBeNull();
    expect(await env.FILES.head(`${pid}/${FILE_VALID}.pdf`)).not.toBeNull();
    expect(await env.FILES.head('misc/keepme.txt')).not.toBeNull();
  });

  it('受管键识别只接受已知命名空间与 UUID 形态', () => {
    const id = crypto.randomUUID();
    expect(classifyManagedKey(`ai-calls/${id}/output.json`)).toEqual({ kind: 'ai_call', id });
    expect(classifyManagedKey(`sources/${id}/text.txt`)).toEqual({ kind: 'source_version', id });
    expect(classifyManagedKey(`${id}/${id}.pdf`)).toEqual({ kind: 'file', id });
    expect(classifyManagedKey('misc/keepme.txt')).toBeNull();
    expect(classifyManagedKey('ai-calls/not-a-uuid/input.json')).toBeNull();
    expect(classifyManagedKey('sources/x/y/z')).toBeNull();
  });

  it('幂等记录只清理已完成的过期记录，processing 永不自动删除', async () => {
    const owner = await seedUser();
    await seedProject(owner.userId);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    for (const [key, status, createdAt] of [
      ['k-completed-old', 'completed', old],
      ['k-completed-new', 'completed', recent],
      ['k-processing-old', 'processing', old],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO idempotency_records (idempotency_key, user_id, operation, request_hash, status, created_at) VALUES (?1, ?2, 'op', 'hash', ?3, ?4)",
      ).bind(key, owner.userId, status, createdAt).run();
    }

    const res = await gcExpiredRecords(env, new Date().toISOString());
    expect(res.idempotencyDeleted).toBe(1);

    const left = await env.DB.prepare('SELECT idempotency_key FROM idempotency_records WHERE user_id = ?1 ORDER BY idempotency_key')
      .bind(owner.userId)
      .all<{ idempotency_key: string }>();
    expect(left.results.map((r) => r.idempotency_key)).toEqual(['k-completed-new', 'k-processing-old']);
  });
});
