import type { AiContinuationMessage, Env } from '../env';

/**
 * Best-effort accelerator only.
 *
 * The durable source of truth remains D1 (`ai_execution_slices` /
 * `draft_preview_dispatches`). If Queue is unavailable, the existing minute
 * recovery cron will dispatch the pending row instead of recursively creating
 * another Workflow from the current Workflow invocation.
 */
export async function enqueueContinuation(env: Env, message: AiContinuationMessage): Promise<boolean> {
  if (!env.AI_CONTINUATION_QUEUE) return false;
  try {
    await env.AI_CONTINUATION_QUEUE.send(message);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'ai_continuation_enqueue_failed', kind: message.kind, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
    return false;
  }
}
