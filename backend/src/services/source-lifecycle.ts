import type { Env } from '../env';
import { invalidState, notFound } from '../core/errors';

/** Shared contract for parse, summaries and future source-reading tools. */
export function sourceLifecycleGuard(versionIdSql: string, lifecycleVersionSql: string): string {
  return `EXISTS (SELECT 1 FROM source_versions lifecycle_v JOIN sources lifecycle_s ON lifecycle_s.id=lifecycle_v.source_id
    WHERE lifecycle_v.id=${versionIdSql} AND lifecycle_s.project_id=lifecycle_v.project_id AND lifecycle_s.deleted_at IS NULL
      AND (${lifecycleVersionSql} IS NULL OR lifecycle_s.lifecycle_version=${lifecycleVersionSql})
      AND (lifecycle_v.origin!='file' OR EXISTS (SELECT 1 FROM files lifecycle_f WHERE lifecycle_f.id=lifecycle_v.file_id
        AND lifecycle_f.project_id=lifecycle_v.project_id AND lifecycle_f.status='available' AND lifecycle_f.deleted_at IS NULL)))`;
}

export async function loadActiveSourceVersion(env: Env, versionId: string, expectedLifecycleVersion?: number): Promise<{ sourceId: string; projectId: string; lifecycleVersion: number }> {
  const row = await env.DB.prepare(`SELECT s.id source_id,s.project_id,s.lifecycle_version FROM source_versions v JOIN sources s ON s.id=v.source_id
    WHERE v.id=?1 AND ${sourceLifecycleGuard('v.id', '?2')}`).bind(versionId,expectedLifecycleVersion ?? null).first<{ source_id:string;project_id:string;lifecycle_version:number }>();
  if (!row) throw notFound('来源已移入回收站、不可用或生命周期已变化');
  return { sourceId:row.source_id,projectId:row.project_id,lifecycleVersion:row.lifecycle_version };
}

export async function assertSourceJobActive(env: Env, jobId: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT 1 FROM jobs j WHERE j.id=?1 AND j.status IN ('queued','running')
    AND ${sourceLifecycleGuard("json_extract(j.input_json,'$.sourceVersionId')", "COALESCE(json_extract(j.input_json,'$.sourceLifecycleVersion'),1)")}`).bind(jobId).first();
  if (!row) throw invalidState('来源任务已取消或引用的生命周期已变化');
}
