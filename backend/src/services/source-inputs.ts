import type { Env } from '../env';
import { invalidState, notFound } from '../core/errors';
import { loadActiveSourceVersion, sourceLifecycleGuard } from './source-lifecycle';

/** Lifecycle is frozen independently of immutable content/version IDs. */
export interface SourceInputSnapshot {
  sourceId: string;
  sourceVersionId: string;
  sourceLifecycleVersion: number;
}

/** Dynamic file tools use a separate bounded snapshot from selected source inputs. */
export interface ToolFileInputSnapshot {
  fileId: string;
  fileLifecycleVersion: number;
  sourceId?: string;
  sourceVersionId?: string;
  sourceLifecycleVersion?: number;
}

export function toolFileInputsGuard(inputJsonSql: string, projectIdSql: string): string {
  return `NOT EXISTS (SELECT 1 FROM json_each(${inputJsonSql},'$.toolFileSnapshots') tool_file WHERE
    NOT EXISTS (SELECT 1 FROM files f WHERE f.id=json_extract(tool_file.value,'$.fileId')
      AND f.project_id=${projectIdSql} AND f.status='available' AND f.deleted_at IS NULL
      AND f.lifecycle_version=json_extract(tool_file.value,'$.fileLifecycleVersion'))
    OR (json_extract(tool_file.value,'$.sourceVersionId') IS NOT NULL AND
      NOT EXISTS (SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id
        WHERE v.id=json_extract(tool_file.value,'$.sourceVersionId') AND v.project_id=${projectIdSql}
          AND v.file_id=json_extract(tool_file.value,'$.fileId') AND s.project_id=${projectIdSql}
          AND s.id=json_extract(tool_file.value,'$.sourceId')
          AND ${sourceLifecycleGuard('v.id', "json_extract(tool_file.value,'$.sourceLifecycleVersion')")})))`;
}

export async function snapshotSourceInputs(env: Env, projectId: string, versionIds: string[]): Promise<SourceInputSnapshot[]> {
  const snapshots: SourceInputSnapshot[] = [];
  for (const sourceVersionId of new Set(versionIds)) {
    const source = await loadActiveSourceVersion(env, sourceVersionId);
    if (source.projectId !== projectId) throw notFound('来源版本不存在或不属于本项目');
    snapshots.push({ sourceId: source.sourceId, sourceVersionId, sourceLifecycleVersion: source.lifecycleVersion });
  }
  if (snapshots.length) {
    const active = await env.DB.prepare(`SELECT 1 WHERE ${sourceInputsGuard('?1', '?2')}`).bind(JSON.stringify({ sourceSnapshots: snapshots }), projectId).first();
    if (!active) throw invalidState('引用的来源已变化，请重新发起');
  }
  return snapshots;
}

export async function assertSourceInputs(env: Env, projectId: string, versionIds: string[], snapshots?: SourceInputSnapshot[]): Promise<void> {
  if (!versionIds.length) {
    if (snapshots?.length) throw invalidState('冻结来源范围不匹配');
    return;
  }
  // Legacy queued jobs with sources but no lifecycle snapshot cannot be safely resumed.
  if (!snapshots || snapshots.length !== new Set(versionIds).size || new Set(snapshots.map(source => source.sourceVersionId)).size !== snapshots.length || snapshots.some(source => !versionIds.includes(source.sourceVersionId) || !Number.isInteger(source.sourceLifecycleVersion) || source.sourceLifecycleVersion < 1)) throw invalidState('来源生命周期快照缺失，请重新发起');
  for (const captured of snapshots) {
    const source = await loadActiveSourceVersion(env, captured.sourceVersionId, captured.sourceLifecycleVersion);
    if (source.projectId !== projectId || source.sourceId !== captured.sourceId) throw invalidState('引用的来源已变化，请重新发起');
  }
  const active = await env.DB.prepare(`SELECT 1 WHERE ${sourceInputsGuard('?1', '?2')}`).bind(JSON.stringify({ sourceSnapshots: snapshots }), projectId).first();
  if (!active) throw invalidState('引用的来源已变化，请重新发起');
}

export function sourceInputsGuard(inputJsonSql: string, projectIdSql: string): string {
  return `NOT EXISTS (SELECT 1 FROM json_each(${inputJsonSql},'$.sourceSnapshots') captured WHERE
    json_extract(captured.value,'$.sourceLifecycleVersion') IS NULL OR
    NOT EXISTS (SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id
      WHERE v.id=json_extract(captured.value,'$.sourceVersionId') AND v.project_id=${projectIdSql} AND s.project_id=${projectIdSql}
      AND s.id=json_extract(captured.value,'$.sourceId') AND ${sourceLifecycleGuard('v.id', "json_extract(captured.value,'$.sourceLifecycleVersion')")}))
      AND ${toolFileInputsGuard(inputJsonSql, projectIdSql)}`;
}

/** A set and every cited original must be available before it is new model input. */
export async function snapshotRequirementSources(env: Env, projectId: string, setId: string): Promise<SourceInputSnapshot[]> {
  const set = await env.DB.prepare('SELECT source_version_id FROM requirement_sets WHERE id=?1 AND project_id=?2').bind(setId, projectId).first<{ source_version_id: string | null }>();
  if (!set) throw notFound('要求集不存在或不属于本项目');
  const rows = await env.DB.prepare(`SELECT DISTINCT COALESCE(json_extract(citation.value,'$.sourceVersionId'),(SELECT fragment.source_version_id FROM source_fragments fragment WHERE fragment.id=json_extract(citation.value,'$.fragmentId') AND fragment.project_id=?2)) version_id
    FROM requirements r, json_each(r.citations_json) citation WHERE r.requirement_set_id=?1 AND r.project_id=?2 ORDER BY version_id`).bind(setId, projectId).all<{ version_id: string | null }>();
  if (rows.results.some(row => typeof row.version_id !== 'string')) throw invalidState('要求集引用的来源证据不可用，请重新选择');
  return snapshotSourceInputs(env, projectId, [set.source_version_id, ...rows.results.map(row => row.version_id)].filter((id): id is string => typeof id === 'string'));
}

export async function assertRequirementSources(env: Env, projectId: string, setId: string | null, snapshots?: SourceInputSnapshot[]): Promise<void> {
  if (!setId) return assertSourceInputs(env, projectId, [], snapshots);
  const current = await snapshotRequirementSources(env, projectId, setId);
  await assertSourceInputs(env, projectId, current.map(source => source.sourceVersionId), snapshots);
  if (JSON.stringify(current) !== JSON.stringify(snapshots ?? [])) throw invalidState('要求集引用来源已变化，请重新发起');
}

export async function sourceReferenceAvailability(env: Env, projectId: string, sourceVersionId: string): Promise<{ availability: 'unavailable'; deletedAt: string | null } | undefined> {
  const row = await env.DB.prepare(`SELECT s.deleted_at, ${sourceLifecycleGuard('v.id', 'NULL')} available
    FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=?1 AND v.project_id=?2 AND s.project_id=?2`).bind(sourceVersionId, projectId).first<{ deleted_at: string | null; available: number }>();
  return row?.available ? undefined : { availability: 'unavailable', deletedAt: row?.deleted_at ?? null };
}

/** Older requirement citations store only fragmentId; keep that historical shape intact. */
export async function sourceCitationAvailability(env: Env, projectId: string, citation: { sourceVersionId?: string; fragmentId?: string }): Promise<{ availability: 'unavailable'; deletedAt: string | null } | undefined> {
  let versionId = citation.sourceVersionId;
  if (!versionId && citation.fragmentId) {
    const fragment = await env.DB.prepare('SELECT source_version_id FROM source_fragments WHERE id=?1 AND project_id=?2').bind(citation.fragmentId, projectId).first<{ source_version_id: string }>();
    versionId = fragment?.source_version_id;
  }
  return versionId ? sourceReferenceAvailability(env, projectId, versionId) : { availability: 'unavailable', deletedAt: null };
}

export async function fileReferenceAvailability(env: Env, projectId: string, fileId: string): Promise<{ availability: 'unavailable'; deletedAt: string | null } | undefined> {
  const file = await env.DB.prepare('SELECT status,deleted_at FROM files WHERE id=?1 AND project_id=?2').bind(fileId, projectId).first<{ status: string; deleted_at: string | null }>();
  return file?.status === 'available' && !file.deleted_at ? undefined : { availability: 'unavailable', deletedAt: file?.deleted_at ?? null };
}
