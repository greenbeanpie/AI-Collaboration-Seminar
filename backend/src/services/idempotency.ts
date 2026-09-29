import type { Env } from '../env';
import { nowIso, sha256Hex } from '../core/db';
import { AppError, invalidState } from '../core/errors';

export interface IdempotencyParams {
  key: string | undefined;
  userId: string;
  operation: string;
  /** 原始请求体文本（未解析），用于同键不同内容的冲突判定 */
  rawBody: string;
}

export interface IdempotentResult<T, S extends number = number> {
  status: S;
  body: T;
  /** 是否为同键同内容的回放 */
  replayed: boolean;
}

/**
 * 幂等执行（PLAN 二.7）：关键 POST 使用 Idempotency-Key。
 * - 未带 Key：直接执行（前端灰度期间不强制）。
 * - 同键同内容且已完成：回放原响应（replayed=true，requestId 为新请求的）。
 * - 同键不同内容：409 IDEMPOTENCY_CONFLICT。
 * - 同键处理中：409 INVALID_STATE。
 * 响应体落库在业务执行成功后进行（半途失败留下 processing 记录，重复请求将得到
 * 「处理中」409，可在下个请求周期由同键重试覆盖？——不：processing 记录由
 * 完成路径覆盖；真正半途失败的记录会在 24h 后可被同键重试替换，见 cleanup）。
 */
export async function withIdempotency<T, S extends number>(
  env: Env,
  params: IdempotencyParams,
  execute: () => Promise<{ status: S; body: T }>,
): Promise<IdempotentResult<T, S>> {
  if (!params.key) {
    const result = await execute();
    return { ...result, replayed: false };
  }
  const requestHash = await sha256Hex(params.rawBody);

  const existing = await env.DB.prepare(
    'SELECT request_hash, status, response_status, response_body FROM idempotency_records WHERE idempotency_key = ?1 AND user_id = ?2 AND operation = ?3',
  )
    .bind(params.key, params.userId, params.operation)
    .first<{ request_hash: string; status: string; response_status: number | null; response_body: string | null }>();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', '相同 Idempotency-Key 但请求内容不同', 409, false);
    }
    if (existing.status === 'completed' && existing.response_body !== null && existing.response_status !== null) {
      return {
        status: existing.response_status as S,
        body: JSON.parse(existing.response_body) as T,
        replayed: true,
      };
    }
    // 半途失败留下的 processing 记录：超过 10 分钟视为过期，允许覆盖
    await env.DB.prepare(
      "DELETE FROM idempotency_records WHERE idempotency_key = ?1 AND user_id = ?2 AND operation = ?3 AND status = 'processing' AND created_at <= ?4",
    )
      .bind(params.key, params.userId, params.operation, new Date(Date.now() - 10 * 60_000).toISOString())
      .run();
    throw invalidState('相同幂等键的请求正在处理中，请稍后重试');
  }

  try {
    await env.DB.prepare(
      "INSERT INTO idempotency_records (idempotency_key, user_id, operation, request_hash, status, created_at) VALUES (?1, ?2, ?3, ?4, 'processing', ?5)",
    )
      .bind(params.key, params.userId, params.operation, requestHash, nowIso())
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      // 并发同键：按处理中处理
      throw invalidState('相同幂等键的请求正在处理中，请稍后重试');
    }
    throw err;
  }

  const result = await execute();
  await env.DB.prepare(
    "UPDATE idempotency_records SET status = 'completed', response_status = ?2, response_body = ?3 WHERE idempotency_key = ?1 AND user_id = ?4 AND operation = ?5",
  )
    .bind(params.key, result.status, JSON.stringify(result.body), params.userId, params.operation)
    .run();
  return { ...result, replayed: false };
}
