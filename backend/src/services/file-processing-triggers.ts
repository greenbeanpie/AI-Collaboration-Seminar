import type { Env } from '../env';
import { ensureFileProcessing, backfillFileProcessing } from './file-processing';

/** Saving an original file must succeed even when its independent processing cannot start. */
export async function triggerFileProcessing(env: Env, projectId: string, fileId: string, actorId: string): Promise<void> {
  try { await ensureFileProcessing(env, projectId, fileId, actorId, { automatic: true }); }
  catch (error) {
    console.error(JSON.stringify({ event: 'file_processing_start_failed', projectId, fileId, code: error instanceof Error ? error.name : 'UNKNOWN' }));
    // Available files remain discoverable by the bounded scheduled backfill.
  }
}

export async function triggerProjectFileProcessing(env: Env, projectId: string): Promise<void> {
  try { await backfillFileProcessing(env, projectId, 10); }
  catch { console.error(JSON.stringify({ event: 'project_file_processing_backfill_failed', projectId })); }
}
