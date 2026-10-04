import type { Env } from '../env';
import { nowIso } from '../core/db';

/** Append after the successful draft/file CAS in the same D1 batch. */
export function cancelDraftMediaStatements(env: Env, input: {
  draftId: string; ownerId: string; revision: number; status: 'active' | 'cancelled';
  token?: string; fileId?: string;
}): D1PreparedStatement[] {
  const guard = `json_extract(j.input_json,'$.operation')='media.draft'
    AND json_extract(j.input_json,'$.draftId')=?1
    AND (?6 IS NULL OR json_extract(j.input_json,'$.fileId')=?6)
    AND EXISTS(SELECT 1 FROM project_creation_drafts d WHERE d.id=?1 AND d.owner_id=?2
      AND d.revision=?3 AND d.status=?4 AND (?5 IS NULL OR d.preview_attempt_id=?5))
    AND (?4='cancelled' OR EXISTS(SELECT 1 FROM creation_draft_files f
      WHERE f.id=json_extract(j.input_json,'$.fileId') AND f.draft_id=?1 AND f.removed=1))`;
  const values = [input.draftId,input.ownerId,input.revision,input.status,input.token??null,input.fileId??null,nowIso()];
  const affected = `SELECT j.id FROM jobs j WHERE j.status='cancelled' AND j.updated_at=?7 AND ${guard}`;
  return [
    env.DB.prepare(`UPDATE jobs AS j SET status='cancelled',error_json=json_object('code','INVALID_STATE','message','草稿或媒体文件已取消'),finished_at=?7,updated_at=?7 WHERE status IN ('queued','running','waiting_input') AND ${guard}`).bind(...values),
    env.DB.prepare(`UPDATE audio_pipeline SET phase='cancelled',error='草稿或媒体文件已取消',updated_at=?7 WHERE phase NOT IN ('ready','cancelled') AND job_id IN (${affected})`).bind(...values),
    env.DB.prepare(`UPDATE media_processing SET stage='failed',error='草稿或媒体文件已取消',updated_at=?7 WHERE stage!='ready' AND job_id IN (${affected})`).bind(...values),
  ];
}
