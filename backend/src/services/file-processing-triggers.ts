import type { Env } from '../env';
import { ensureFileProcessing, backfillFileProcessing, syncFileProcessingText } from './file-processing';

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

/** Purpose changes and removed attachments must also update previously derived outputs. */
export async function syncMaterialFileProcessing(env: Env, projectId: string, materialId: string): Promise<void> {
  const linked = await env.DB.prepare(`SELECT DISTINCT l.source_version_id FROM file_processing_materials l
    JOIN materials m ON m.id=COALESCE(l.parent_material_id,l.material_id)
    WHERE m.id=?1 AND m.project_id=?2`).bind(materialId,projectId).all<{source_version_id:string}>();
  for (const item of linked.results) await syncFileProcessingText(env,item.source_version_id);
}
