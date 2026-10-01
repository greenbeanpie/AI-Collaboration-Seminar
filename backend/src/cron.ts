import { dispatchNotifications } from './services/notifications';
import type { Env } from './env';
import { nowIso } from './core/db';
import { tryDispatchJob, reconcileWorkflowJob, failJob } from './services/jobs';
import { releaseStaleReservations, settleReservation } from './services/budget';
import { gcExpiredRecords, gcOrphanObjects } from './services/gc';

/**
 * 定时维护（crons 每分钟触发）：
 * 1. 任务恢复器：补投 outbox 中待派发/租约过期的任务（确定性实例 ID 防重复）。
 * 2. 回收到期的隔离文件（校验失败暂存的 R2 对象）。
 * 3. 清理过期会话与验证码挑战。
 */
export async function handleScheduled(env: Env): Promise<void> {
  try { await dispatchNotifications(env); } catch { console.error('[cron] Notification dispatch failed'); }
  const now = nowIso();
  const staleRunning = await env.DB.prepare("SELECT id FROM jobs WHERE status = 'running' AND updated_at <= ?1 ORDER BY updated_at LIMIT 10").bind(new Date(new Date(now).getTime() - 5 * 60_000).toISOString()).all<{ id: string }>();
  for (const job of staleRunning.results) {
    try { await reconcileWorkflowJob(env, job.id); } catch (error) { console.error('[cron] Workflow 状态核对失败', job.id, error); }
  }
  // Requeue missing instances before selecting the due outbox, so recovery dispatches in this run.
  await recoverJobs(env, nowIso());
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
    await env.DB.prepare('DELETE FROM auth_email_ip_attempts WHERE attempted_at <= ?1').bind(new Date(new Date(now).getTime() - 2 * 3600_000).toISOString()).run();
  } catch (err) {
    console.error('[cron] 定时维护失败（迁移未应用或依赖暂不可用时不致命）:', err);
  }

  // 孤儿 R2 对象回收（只删超过宽限期且数据库无引用的受管对象）
  try {
    const orphan = await gcOrphanObjects(env, now);
    if (orphan.deleted.length > 0 || orphan.failures > 0) {
      console.log('[cron] 孤儿对象回收', JSON.stringify(orphan));
    }
  } catch (err) {
    console.error('[cron] 孤儿对象回收失败:', err);
  }

  // 数据保留：已完成的幂等回放记录到期清理（processing 保留给运维核对）
  try {
    const retention = await gcExpiredRecords(env, now);
    if (retention.idempotencyDeleted > 0) {
      console.log('[cron] 幂等记录清理', JSON.stringify(retention));
    }
  } catch (err) {
    console.error('[cron] 幂等记录清理失败:', err);
  }
}

/** 恢复器：抢占到期租约 → 重建 Workflow 实例（实例已存在则核对状态，不重复创建） */
export async function recoverJobs(env: Env, now: string): Promise<void> {
  try {
    const due = await env.DB
      .prepare(
        `SELECT o.job_id, o.attempts, j.updated_at FROM job_outbox o JOIN jobs j ON j.id = o.job_id
         WHERE o.status = 'pending' AND o.available_at <= ?1 AND j.status IN ('queued', 'waiting_input')
           AND (o.lease_until IS NULL OR o.lease_until <= ?1)
         ORDER BY o.available_at LIMIT 10`,
      )
      .bind(now)
      .all<{ job_id: string; attempts: number; updated_at: string }>();
    for (const row of due.results) {
      if (row.attempts >= 5) {
        const failed = await failJob(env, row.job_id, { code: 'INTERNAL', message: '任务派发多次失败' }, row.updated_at);
        if (failed) await settleReservation(env, row.job_id, 'released');
        continue;
      }
      const claim = await env.DB.prepare(
        `UPDATE job_outbox SET lease_until = ?2, attempts = attempts + 1, updated_at = ?3
          WHERE job_id = ?1 AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?3)
            AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_outbox.job_id AND jobs.status IN ('queued', 'waiting_input') AND jobs.updated_at = ?4)`,
      )
        .bind(row.job_id, new Date(new Date(now).getTime() + 5 * 60_000).toISOString(), now, row.updated_at)
        .run();
      if ((claim.meta?.changes ?? 0) === 0) continue;
      await tryDispatchJob(env, row.job_id);
    }
  } catch (err) {
    console.error('[cron] 任务恢复失败:', err);
  }
}
