import { assertSourceInputs } from './source-inputs';
import type { Env } from '../env';
import { invalidState, validationFailed } from '../core/errors';

export interface ProjectSourceSnapshot {
  sourceId: string;
  sourceVersionId: string;
  sourceLifecycleVersion: number;
  title: string;
  fragments: Array<{ fragmentId: string; pageNumber: number | null; content: string }>;
}

/** Complete immutable text only; originals and summaries remain separate records. */
export async function readProjectSourceContext(env: Env, projectId: string, versionIds: string[]): Promise<ProjectSourceSnapshot[]> {
  if (!versionIds.length || versionIds.length > 5 || new Set(versionIds).size !== versionIds.length) throw validationFailed('每次请选择1至5份不同来源');
  const snapshots: ProjectSourceSnapshot[] = [];
  let totalChars = 0;
  for (const sourceVersionId of versionIds) {
    const version = await env.DB.prepare(`SELECT s.id,s.title,s.lifecycle_version,v.char_count,v.origin,v.file_id,processing.text_status,processing.project_id AS processing_project_id FROM source_versions v JOIN sources s ON s.id=v.source_id AND s.current_version_id=v.id LEFT JOIN source_processing processing ON processing.source_version_id=v.id WHERE v.id=?1 AND v.project_id=?2 AND s.project_id=?2 AND s.deleted_at IS NULL AND (v.origin!='file' OR EXISTS(SELECT 1 FROM files f WHERE f.id=v.file_id AND f.project_id=?2 AND f.status='available' AND f.deleted_at IS NULL))`).bind(sourceVersionId, projectId).first<{ id: string; title: string; lifecycle_version: number; char_count: number | null; origin: string; file_id: string | null; text_status: string | null; processing_project_id: string | null }>();
    if (!version) throw invalidState('选择的来源已变化、已移除或不属于本项目，请重新选择');
    const missing = await env.DB.prepare("SELECT COUNT(*) n FROM source_pages WHERE source_version_id=?1 AND text_status='none' AND ocr_status!='ok'").bind(sourceVersionId).first<{ n: number }>();
    const fragments = await env.DB.prepare('SELECT id,page_number,content FROM source_fragments WHERE source_version_id=?1 AND project_id=?2 ORDER BY seq,id').bind(sourceVersionId, projectId).all<{ id: string; page_number: number | null; content: string }>();
    if ((version.text_status && (version.text_status !== 'ready' || version.processing_project_id !== projectId)) || !version.char_count || missing?.n || !fragments.results.length) throw invalidState(`「${version.title}」正文尚未完整就绪，请先在来源页面完成读取或缺页识别；当前不会生成基于未读文件的任务`);
    totalChars += fragments.results.reduce((sum, fragment) => sum + fragment.content.length, 0);
    if (totalChars > 60_000) throw validationFailed('选定来源正文超过单次60000字符安全范围，请减少选择；不会静默截断来源或绕过模型自身输入上限');
    snapshots.push({ sourceId: version.id, sourceVersionId, sourceLifecycleVersion: version.lifecycle_version, title: version.title, fragments: fragments.results.map(fragment => ({ fragmentId: fragment.id, pageNumber: fragment.page_number, content: fragment.content })) });
  }
  await assertSourceInputs(env, projectId, versionIds, snapshots);
  return snapshots;
}

export async function assertProjectSourceContext(env: Env, projectId: string, snapshots?: ProjectSourceSnapshot[]): Promise<void> {
  if (!snapshots?.length) return;
  const current = await readProjectSourceContext(env, projectId, snapshots.map(source => source.sourceVersionId));
  if (JSON.stringify(current) !== JSON.stringify(snapshots)) throw invalidState('引用的项目来源已变化，请重新发起任务协作');
}

/** Atomic counterpart of the dispatch guard, used inside the proposal mutation CAS. */
export function projectSourceContextGuard(inputJsonSql: string, projectIdSql: string): string {
  return `NOT EXISTS(SELECT 1 FROM json_each(${inputJsonSql},'$.sourceSnapshots') snapshot WHERE
    NOT EXISTS(SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id AND s.current_version_id=v.id WHERE v.id=json_extract(snapshot.value,'$.sourceVersionId') AND v.project_id=${projectIdSql} AND s.id=json_extract(snapshot.value,'$.sourceId') AND s.project_id=${projectIdSql} AND s.deleted_at IS NULL AND s.lifecycle_version=json_extract(snapshot.value,'$.sourceLifecycleVersion') AND s.title=json_extract(snapshot.value,'$.title') AND v.char_count>0 AND NOT EXISTS(SELECT 1 FROM source_processing processing WHERE processing.source_version_id=v.id AND (processing.project_id!=${projectIdSql} OR processing.text_status!='ready')) AND (v.origin!='file' OR EXISTS(SELECT 1 FROM files f WHERE f.id=v.file_id AND f.project_id=${projectIdSql} AND f.status='available' AND f.deleted_at IS NULL)))
    OR EXISTS(SELECT 1 FROM source_pages page WHERE page.source_version_id=json_extract(snapshot.value,'$.sourceVersionId') AND page.text_status='none' AND page.ocr_status!='ok')
    OR (SELECT COUNT(*) FROM source_fragments fragment WHERE fragment.source_version_id=json_extract(snapshot.value,'$.sourceVersionId') AND fragment.project_id=${projectIdSql})!=json_array_length(snapshot.value,'$.fragments')
    OR EXISTS(SELECT 1 FROM json_each(snapshot.value,'$.fragments') captured WHERE NOT EXISTS(SELECT 1 FROM source_fragments fragment WHERE fragment.id=json_extract(captured.value,'$.fragmentId') AND fragment.source_version_id=json_extract(snapshot.value,'$.sourceVersionId') AND fragment.project_id=${projectIdSql} AND fragment.page_number IS json_extract(captured.value,'$.pageNumber') AND fragment.content=json_extract(captured.value,'$.content'))))`;
}
