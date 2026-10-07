import { backfillFileProcessing } from './services/file-processing';
import { recoverChatContextCleanup } from './services/project-ai-chat';
import { backfillTaskAgentEligibility } from './services/task-agent-eligibility';
import { backfillResourceIndexes } from './services/resource-index';
import { cleanupMediaFiles } from './services/media-summary';
import { invalidateStaleProjectClarifications } from './services/ai-clarifications';
import { recoverDraftPreviews } from './services/draft-preview-jobs';
import { recoverAutomaticAiRetries } from './services/ai-automatic-retries';
import { recoverAdminAiRetries, retryFailedAiJob } from './services/admin-ai-retries';
import { cleanupExpiredRehearsalVoiceSessions } from './services/rehearsal-voice';
import { retireCloudRehearsalSpeechJobs } from './services/rehearsal-speech';
import { recoverExecutionSlices } from './services/ai-execution-slices';
import { dispatchNotifications } from './services/notifications';
import type { Env } from './env';
import { nowIso } from './core/db';
import { tryDispatchJob, reconcileWorkflowJob, failJob } from './services/jobs';
import { releaseStaleReservations, settleReservation } from './services/ai-reservations';
import { gcExpiredRecords, gcOrphanObjects } from './services/gc';
import { dispatchProjectProgression } from './services/project-progression';

export const CRON_GROUPS = {
  recovery: '* * * * *',
  backfill: '*/10 * * * *',
  cleanup: '0 * * * *',
  orphan: '0 3 * * *',
} as const;
export function scheduledGroups(cron?: string): Array<keyof typeof CRON_GROUPS> {
  // Direct callers historically run all maintenance (tests and explicit operator checks).
  if (cron === undefined) return Object.keys(CRON_GROUPS) as Array<keyof typeof CRON_GROUPS>;
  return (Object.keys(CRON_GROUPS) as Array<keyof typeof CRON_GROUPS>).filter(group => CRON_GROUPS[group] === cron);
}
async function attempt(name: string, task: () => Promise<unknown>): Promise<boolean> {
  try { await task(); return true; } catch { console.error(JSON.stringify({ event: 'cron_operation_failed', operation: name })); return false; }
}
export async function handleScheduled(env: Env, cron?: string): Promise<void> {
  const now = nowIso();
  for (const group of scheduledGroups(cron)) {
    const started = Date.now();
    let failures = 0;
    const run = async (name: string, task: () => Promise<unknown>) => { if (!await attempt(name, task)) failures++; };
    try {
      if (group === 'recovery') {
        await run('file_processing', () => backfillFileProcessing(env, undefined, 10));
        await run('progression', () => dispatchProjectProgression(env));
        await run('notifications', () => dispatchNotifications(env));
        await run('admin_retry', () => recoverAdminAiRetries(env));
        await run('chat_context_cleanup', () => recoverChatContextCleanup(env));
        await run('automatic_retry', () => recoverAutomaticAiRetries(env, (retryEnv, jobId, rootId) => retryFailedAiJob(retryEnv, jobId, undefined, rootId)));
        await run('workflow_reconcile', async () => {
          const stale = await env.DB.prepare("SELECT id FROM jobs WHERE status = 'running' AND updated_at <= ?1 ORDER BY updated_at LIMIT 10")
            .bind(new Date(new Date(now).getTime() - 5 * 60_000).toISOString()).all<{id: string}>();
          for (const job of stale.results) await run('workflow_job', () => reconcileWorkflowJob(env, job.id));
        });
        await run('execution_slices', () => recoverExecutionSlices(env));
        await run('draft_previews', () => recoverDraftPreviews(env));
        await recoverJobs(env, nowIso());
        await run('reservations', () => releaseStaleReservations(env, now));
      } else if (group === 'backfill') {
        await run('task_eligibility', () => backfillTaskAgentEligibility(env));
        await run('resource_indexes', () => backfillResourceIndexes(env, 5));
        await run('clarifications', () => invalidateStaleProjectClarifications(env));
      } else if (group === 'cleanup') {
        await run('legacy_speech', () => retireCloudRehearsalSpeechJobs(env));
        await run('voice_sessions', () => cleanupExpiredRehearsalVoiceSessions(env));
        await run('media_files', () => cleanupMediaFiles(env));
        await cleanupRecords(env, now);
      } else await cleanupOrphans(env, now);
    } catch { failures++; console.error(JSON.stringify({event: 'cron_group_failed', group})); }
    finally { console.log(JSON.stringify({event: 'cron_group_completed', group, failures, elapsedMs: Date.now() - started})); }
  }
}
async function cleanupRecords(env: Env, now: string): Promise<void> {
  try {
    const quarantined = await env.DB
      .prepare("SELECT id, r2_key FROM files WHERE status = 'quarantined' AND deleted_at IS NULL AND gc_after IS NOT NULL AND gc_after <= ?1")
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
async function cleanupOrphans(env: Env, now: string): Promise<void> {
  // 孤儿 R2 对象回收（只删超过宽限期且数据库无引用的受管对象）
  try {
    const orphan = await gcOrphanObjects(env, now);
    if (orphan.deleted.length > 0 || orphan.failures > 0) {
      console.log('[cron] 孤儿对象回收', JSON.stringify(orphan));
    }
  } catch (err) {
    console.error('[cron] 孤儿对象回收失败:', err);
  }


}

/** 恢复器：抢占到期租约 → 重建 Workflow 实例（实例已存在则核对状态，不重复创建） */
export async function recoverJobs(env: Env, now: string): Promise<void> {
  try {
    // A received question proves initial execution reached a durable pause, even
    // when Workflow.create lost its response. Only the answer may resume it.
    const due = await env.DB
      .prepare(
        `SELECT o.job_id, o.attempts, j.updated_at FROM job_outbox o JOIN jobs j ON j.id = o.job_id
         WHERE o.status = 'pending' AND o.available_at <= ?1 AND j.status IN ('queued', 'waiting_input')
           AND NOT EXISTS (SELECT 1 FROM ai_clarifications q WHERE q.job_id = j.id AND q.status = 'pending')
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
            AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_outbox.job_id AND jobs.status IN ('queued', 'waiting_input') AND jobs.updated_at = ?4)
            AND NOT EXISTS (SELECT 1 FROM ai_clarifications q WHERE q.job_id = job_outbox.job_id AND q.status = 'pending')`,
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
