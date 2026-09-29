import type { Env } from './env';
import { nowIso } from './core/db';
import { tryDispatchJob } from './services/jobs';
import { releaseStaleReservations } from './services/budget';

/**
 * 定时维护（crons 每分钟触发）：
 * 1. 任务恢复器：补投 outbox 中待派发/租约过期的任务（确定性实例 ID 防重复）。
 * 2. 回收到期的隔离文件（校验失败暂存的 R2 对象）。
 * 3. 清理过期会话与验证码挑战。
 */
export async function handleScheduled(env: Env): Promise<void> {
  const now = nowIso();
  await recoverJobs(env, now);
  await releaseStaleReservations(env, now);
  try {
    const quarantined = await env.DB
      .prepare("SELECT id, r2_key FROM files WHERE status = 'quarantined' AND gc_after IS NOT NULL AND gc_after <= ?1")
      .bind(now)
      .all<{ id: string; r2_key: string }>();
    for (const row of quarantined.results) {
      try {
        await env.FILES.delete(row.r2_key);
      } catch (err) {
        console.error(`[cron] 删除隔离对象失败 file=${row.id}`, err);
        continue;
      }
      await env.DB
        .prepare("UPDATE files SET status = 'discarded', r2_key = '' WHERE id = ?1")
        .bind(row.id)
        .run();
    }
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now).run();
    await env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?1').bind(now).run();
  } catch (err) {
    console.error('[cron] 定时维护失败（迁移未应用或依赖暂不可用时不致命）:', err);
  }
}

/** 恢复器：抢占到期租约 → 重建 Workflow 实例（实例已存在则核对状态，不重复创建） */
async function recoverJobs(env: Env, now: string): Promise<void> {
  try {
    const due = await env.DB
      .prepare(
        `SELECT o.job_id, o.attempts FROM job_outbox o JOIN jobs j ON j.id = o.job_id
         WHERE o.status = 'pending' AND o.available_at <= ?1 AND j.status IN ('queued', 'waiting_input')
           AND (o.lease_until IS NULL OR o.lease_until <= ?1)
         ORDER BY o.available_at LIMIT 10`,
      )
      .bind(now)
      .all<{ job_id: string; attempts: number }>();
    for (const row of due.results) {
      if (row.attempts >= 5) {
        await env.DB.prepare(
          "UPDATE jobs SET status = 'failed', error_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('queued', 'waiting_input')",
        )
          .bind(row.job_id, JSON.stringify({ code: 'INTERNAL', message: '任务派发多次失败' }), nowIso())
          .run();
        await env.DB.prepare("UPDATE job_outbox SET status = 'failed', last_error = 'dispatch_exhausted', updated_at = ?2 WHERE job_id = ?1")
          .bind(row.job_id, nowIso())
          .run();
        continue;
      }
      await env.DB.prepare(
        'UPDATE job_outbox SET lease_until = ?2, attempts = attempts + 1, updated_at = ?2 WHERE job_id = ?1 AND (lease_until IS NULL OR lease_until <= ?2)',
      )
        .bind(row.job_id, new Date(Date.now() + 5 * 60_000).toISOString())
        .run();
      await tryDispatchJob(env, row.job_id);
    }
  } catch (err) {
    console.error('[cron] 任务恢复失败:', err);
  }
}
