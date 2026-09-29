import type { Env } from '../env';
import { nowIso } from '../core/db';

export interface EventInput {
  projectId: string;
  actorType: 'user' | 'ai' | 'system';
  actorId?: string;
  type: string;
  entityType: string;
  entityId?: string;
  dedupKey?: string;
  payload?: unknown;
}

/**
 * 过程账本写入（PLAN 二.2）：按 项目/操作/事件类型/实体 唯一约束去重，
 * 重复事件静默忽略（幂等），绝不因账本失败阻断业务（调用方在 batch 外使用）。
 */
export async function recordEvent(env: Env, input: EventInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO events (id, project_id, actor_type, actor_id, type, entity_type, entity_id, dedup_key, payload_json, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (project_id, type, entity_type, entity_id, dedup_key) DO NOTHING`,
    )
      .bind(
        crypto.randomUUID(),
        input.projectId,
        input.actorType,
        input.actorId ?? '',
        input.type,
        input.entityType,
        input.entityId ?? '',
        input.dedupKey ?? '',
        JSON.stringify(input.payload ?? {}),
        nowIso(),
      )
      .run();
  } catch (err) {
    console.error('[events] 账本写入失败（不阻断业务）:', err);
  }
}
