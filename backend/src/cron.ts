import type { Env } from './env';
import { nowIso } from './core/db';

/**
 * 定时维护（crons 每分钟触发）：
 * 1. 回收到期的隔离文件（校验失败暂存的 R2 对象）。
 * 2. 清理过期会话与验证码挑战。
 * 任务恢复器（job_outbox 派发）在 M3 接入 Workflows 后启用，见 backend_plan.md 4.6。
 */
export async function handleScheduled(env: Env): Promise<void> {
  const now = nowIso();
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
