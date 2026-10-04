import type { Env } from '../env';
import { LIMITS } from '../core/limits';

/**
 * 孤儿对象回收与数据保留（A13）。
 *
 * 保留策略（详见 backend/docs/DEPLOY.md 第 9 节）：
 * - R2：隔离文件按 gc_after 回收（cron 既有逻辑）；受管键在宽限期后被判定为孤儿才删除。
 * - D1：过期会话/验证码即时清理；已完成的幂等回放记录保留 30 天后清理，
 *   processing 记录**永不自动删除**（业务可能已成功，需运维核对，见 A08）。
 * - 业务与账本数据（projects/tasks/materials/events/jobs 等）不自动删除，属审计数据。
 *
 * 安全约束：只处理已知受管键；只删除「数据库无引用」且「上传时间早于宽限期」的对象；
 * 单次最多删除 orphanGcMaxObjectsPerRun 个；支持 dryRun 预演。
 */

export interface OrphanGcResult {
  scanned: number;
  deleted: string[];
  keptReferenced: number;
  keptRecent: number;
  skippedUnmanaged: number;
  failures: number;
}

type OwnerKind = 'audio_pipeline' | 'ai_call' | 'source_version' | 'file' | 'investigation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 解析受管对象键的归属；返回 null 表示不属于受管命名空间，一律不处理。 */
export function classifyManagedKey(key: string): { kind: OwnerKind; id: string } | null {
  const segments = key.split('/');
  if (segments[0] === 'audio-pipeline' && segments.length === 3 && UUID_RE.test(segments[1] ?? '') && segments[2] === 'transcript.json') return {kind:'audio_pipeline',id:segments[1]!};
  if (segments[0] === 'ai' && segments[1] === 'investigations' && segments.length === 3 && segments[2]?.endsWith('.json')) {
    return { kind: 'investigation', id: segments[2].slice(0,-5) };
  }
  if (segments[0] === 'ai-calls' && segments.length >= 3 && UUID_RE.test(segments[1] ?? '')) {
    return { kind: 'ai_call', id: segments[1] as string };
  }
  if (segments[0] === 'sources' && segments.length >= 3 && UUID_RE.test(segments[1] ?? '')) {
    return { kind: 'source_version', id: segments[1] as string };
  }
  // 文件对象：{projectId}/{fileId}{ext}
  if (segments.length === 2 && UUID_RE.test(segments[0] ?? '')) {
    const fileId = (segments[1] ?? '').split('.')[0] ?? '';
    if (UUID_RE.test(fileId)) return { kind: 'file', id: fileId };
  }
  return null;
}

async function isReferenced(env: Env, owner: { kind: OwnerKind; id: string }, key: string): Promise<boolean> {
  if(owner.kind==='audio_pipeline')return Boolean(await env.DB.prepare('SELECT 1 FROM audio_pipeline WHERE job_id=?1 AND transcript_r2_key=?2').bind(owner.id,key).first());
  if(owner.kind==='investigation')return Boolean(await env.DB.prepare('SELECT 1 FROM ai_investigations WHERE id=?1 AND checkpoint_key=?2').bind(owner.id,key).first());
  if (owner.kind === 'ai_call') {
    return Boolean(await env.DB.prepare('SELECT 1 AS ok FROM ai_calls WHERE id = ?1').bind(owner.id).first());
  }
  if (owner.kind === 'source_version') {
    return Boolean(await env.DB.prepare('SELECT 1 AS ok FROM source_versions WHERE id = ?1').bind(owner.id).first());
  }
  // 文件按对象键引用（r2_key），而不是按 id，避免同名不同扩展名误判
  return Boolean(await env.DB.prepare('SELECT 1 AS ok FROM files WHERE r2_key = ?1').bind(key).first());
}

export async function gcOrphanObjects(
  env: Env,
  now: string,
  options?: { graceDays?: number; maxObjects?: number; dryRun?: boolean },
): Promise<OrphanGcResult> {
  const graceDays = options?.graceDays ?? LIMITS.orphanObjectGraceDays;
  const maxObjects = options?.maxObjects ?? LIMITS.orphanGcMaxObjectsPerRun;
  const dryRun = options?.dryRun ?? false;
  const cutoff = new Date(new Date(now).getTime() - graceDays * 86_400_000).toISOString();

  const result: OrphanGcResult = {
    scanned: 0,
    deleted: [],
    keptReferenced: 0,
    keptRecent: 0,
    skippedUnmanaged: 0,
    failures: 0,
  };

  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await env.FILES.list({ limit: 100, cursor });
    for (const object of page.objects) {
      if (removed >= maxObjects) break;
      result.scanned++;
      const owner = classifyManagedKey(object.key);
      if (!owner) {
        result.skippedUnmanaged++;
        continue;
      }
      if (object.uploaded.toISOString() > cutoff) {
        result.keptRecent++;
        continue;
      }
      if (await isReferenced(env, owner, object.key)) {
        result.keptReferenced++;
        continue;
      }
      removed++;
      if (dryRun) {
        result.deleted.push(object.key);
        continue;
      }
      try {
        await env.FILES.delete(object.key);
        result.deleted.push(object.key);
      } catch (error) {
        result.failures++;
        console.error('[gc] 删除孤儿对象失败', object.key, error);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && removed < maxObjects);

  return result;
}

/** 清理已完成的幂等回放记录；processing 记录保留给运维核对。 */
export async function gcExpiredRecords(
  env: Env,
  now: string,
  options?: { idempotencyRetentionDays?: number },
): Promise<{ idempotencyDeleted: number }> {
  const days = options?.idempotencyRetentionDays ?? LIMITS.idempotencyCompletedRetentionDays;
  const before = new Date(new Date(now).getTime() - days * 86_400_000).toISOString();
  const res = await env.DB.prepare(
    "DELETE FROM idempotency_records WHERE status = 'completed' AND created_at <= ?1",
  )
    .bind(before)
    .run();
  return { idempotencyDeleted: res.meta?.changes ?? 0 };
}
