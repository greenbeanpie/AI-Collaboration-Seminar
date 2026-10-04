import type { Env } from '../env';
import { nowIso, sha256Hex } from '../core/db';
import { AppError, invalidState, validationFailed } from '../core/errors';

export interface IdempotencyParams {
  key: string | undefined;
  userId: string;
  operation: string;
  /** 原始请求体文本（未解析），用于同键不同内容的冲突判定 */
  rawBody: string;
  /** Pre-upgrade canonical body; only used to recover an existing record. */
  legacyRawBody?: string;
  /** 冻结写请求必须携带 Idempotency-Key（A08）；缺少时返回 400 而不是静默执行 */
  required?: boolean;
}

export interface IdempotentResult<T, S extends number = number> {
  status: S;
  body: T;
  /** 是否为同键同内容的回放 */
  replayed: boolean;
}

/**
 * 幂等执行（PLAN 二.7）：关键 POST 使用 Idempotency-Key。
 * - 未带 Key 且 required：400 VALIDATION_FAILED；未带 Key 且非 required：直接执行。
 * - 同键同内容且已完成：回放原响应（replayed=true，requestId 为新请求的）。
 * - 同键不同内容：409 IDEMPOTENCY_CONFLICT。
 * - 同键处理中：409 INVALID_STATE。
 * 业务成功而响应记录失败时保留 processing，禁止过期删除后重复执行。
 * 运维恢复路径：GET /api/v1/admin/idempotency/stuck 列出滞留记录，
 * POST /api/v1/admin/idempotency/release 人工确认业务状态后释放该键以便重试。
 */
export async function withIdempotency<T, S extends number>(
  env: Env,
  params: IdempotencyParams,
  execute: () => Promise<{ status: S; body: T }>,
): Promise<IdempotentResult<T, S>> {
  if (!params.key) {
    if (params.required) throw validationFailed('该请求必须携带 Idempotency-Key 请求头');
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
    const legacyMatch = existing.request_hash !== requestHash && params.legacyRawBody !== undefined && existing.request_hash === await sha256Hex(params.legacyRawBody);
    if (existing.request_hash !== requestHash && !legacyMatch) {
      throw new AppError('IDEMPOTENCY_CONFLICT', '相同 Idempotency-Key 但请求内容不同', 409, false);
    }
    if (existing.status === 'completed' && existing.response_body !== null && existing.response_status !== null) {
      return {
        status: existing.response_status as S,
        body: JSON.parse(existing.response_body) as T,
        replayed: true,
      };
    }
    // 不自动删除 processing：业务可能已成功，需要核对后恢复响应，避免重复副作用。
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

export interface StuckIdempotencyRecord {
  idempotencyKey: string;
  userId: string;
  operation: string;
  requestHash: string;
  createdAt: string;
}

/**
 * 列出滞留的 processing 记录（运维核对用）。
 * 业务可能已成功而响应记录写入失败，因此这些记录不能自动删除，只能人工确认后释放。
 */
export async function listStuckIdempotencyRecords(
  env: Env,
  olderThanMinutes = 10,
  limit = 50,
): Promise<StuckIdempotencyRecord[]> {
  const before = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT idempotency_key, user_id, operation, request_hash, created_at
       FROM idempotency_records
      WHERE status = 'processing' AND created_at <= ?1
      ORDER BY created_at
      LIMIT ?2`,
  )
    .bind(before, limit)
    .all<{ idempotency_key: string; user_id: string; operation: string; request_hash: string; created_at: string }>();
  return rows.results.map((row) => ({
    idempotencyKey: row.idempotency_key,
    userId: row.user_id,
    operation: row.operation,
    requestHash: row.request_hash,
    createdAt: row.created_at,
  }));
}

/**
 * 释放一条滞留的 processing 记录，使同一幂等键可以重新执行。
 * 仅在运维已人工确认业务状态（业务未生效，或重试本身是幂等的）后调用。
 */
export async function releaseIdempotencyRecord(
  env: Env,
  params: { idempotencyKey: string; userId: string; operation: string },
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM idempotency_records WHERE idempotency_key = ?1 AND user_id = ?2 AND operation = ?3 AND status = 'processing'",
  )
    .bind(params.idempotencyKey, params.userId, params.operation)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
