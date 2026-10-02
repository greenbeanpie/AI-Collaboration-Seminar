import type { Env } from '../env';
import { nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { readProjectSourceContext } from './collaboration-context';
import { docToMarkdown, isTiptapDoc } from './tiptap';

export type ResourcePurpose = 'background' | 'reference' | 'output';
export type ResourceType = 'source' | 'material';

function backgroundIds(projectId: string) {
  const nibble = Number.parseInt(projectId[0]!, 16);
  return {
    materialId: ((nibble + 8) % 16).toString(16) + projectId.slice(1),
    versionId: ((nibble + 4) % 16).toString(16) + projectId.slice(1),
  };
}

/** Include after project/member INSERTs in the caller's creation batch. */
export function projectBackgroundStatements(env: Env, projectId: string, description: string, actorId: string, createdAt = nowIso()): D1PreparedStatement[] {
  if (!description.trim()) return [];
  const { materialId, versionId } = backgroundIds(projectId);
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] };
  return [
    env.DB.prepare(`INSERT INTO materials(id,project_id,title,kind,purpose,is_default_background,current_version_id,revision,created_by,created_at,updated_at)
      SELECT ?1,?2,'项目背景','background','background',1,?3,1,?4,?5,?5
      WHERE EXISTS(SELECT 1 FROM projects WHERE id=?2)
        AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4)
        AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=?2 AND is_default_background=1)
      ON CONFLICT DO NOTHING`).bind(materialId, projectId, versionId, actorId, createdAt),
    env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
      SELECT ?1,?2,?3,1,?4,?5,'manual',?6,?7
      WHERE EXISTS(SELECT 1 FROM materials WHERE id=?2 AND project_id=?3 AND is_default_background=1 AND current_version_id=?1)
        AND NOT EXISTS(SELECT 1 FROM material_versions WHERE material_id=?2)
      ON CONFLICT DO NOTHING`).bind(versionId, materialId, projectId, JSON.stringify(doc), description, actorId, createdAt),
  ];
}

/** Idempotent repair helper; never replaces a user's edited background. */
export async function ensureProjectBackground(env: Env, projectId: string, description: string, actorId: string): Promise<{ materialId: string; versionId: string } | null> {
  if (!description.trim()) return null;
  if (!await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId, actorId).first()) throw permissionDenied();
  await env.DB.batch(projectBackgroundStatements(env, projectId, description, actorId));
  const row = await env.DB.prepare('SELECT id,current_version_id FROM materials WHERE project_id=?1 AND is_default_background=1').bind(projectId).first<{ id: string; current_version_id: string }>();
  if (!row) throw invalidState('项目背景未保存，请重新读取项目');
  return { materialId: row.id, versionId: row.current_version_id };
}

export interface ResourceVersionText {
  resourceType: ResourceType;
  resourceId: string;
  versionId: string;
  title: string;
  purpose: ResourcePurpose;
  revision: number;
  text: string;
  sourceLifecycleVersion?: number;
  fragments?: Array<{ fragmentId: string; pageNumber: number | null; content: string }>;
}

/** Project access is enforced by the calling endpoint. Never silently truncates. */
export async function loadResourceVersionText(env: Env, projectId: string, resourceType: ResourceType, versionId: string): Promise<ResourceVersionText> {
  if (resourceType === 'source') {
    const [snapshot] = await readProjectSourceContext(env, projectId, [versionId]);
    const row = await env.DB.prepare(`SELECT s.purpose,v.revision FROM sources s JOIN source_versions v ON v.source_id=s.id
      WHERE v.id=?1 AND s.project_id=?2 AND v.project_id=?2`).bind(versionId, projectId).first<{ purpose: ResourcePurpose; revision: number }>();
    if (!snapshot || !row) throw notFound('来源版本不存在');
    return { resourceType, resourceId: snapshot.sourceId, versionId, title: snapshot.title, purpose: row.purpose,
      revision: row.revision, text: snapshot.fragments.map(f => f.content).join('\n'),
      sourceLifecycleVersion: snapshot.sourceLifecycleVersion, fragments: snapshot.fragments };
  }
  const row = await env.DB.prepare(`SELECT m.id,m.title,m.purpose,v.revision,v.doc_json FROM material_versions v
    JOIN materials m ON m.id=v.material_id AND m.project_id=v.project_id WHERE v.id=?1 AND m.project_id=?2`)
    .bind(versionId, projectId).first<{ id: string; title: string; purpose: ResourcePurpose; revision: number; doc_json: string }>();
  if (!row) throw notFound('材料版本不存在');
  const doc: unknown = JSON.parse(row.doc_json);
  if (!isTiptapDoc(doc)) throw invalidState('材料版本正文格式无效');
  const text = docToMarkdown(doc);
  if (text.length > 60_000) throw invalidState('材料正文超过单次60000字符范围，请减少选择');
  return { resourceType, resourceId: row.id, versionId, title: row.title, purpose: row.purpose, revision: row.revision, text };
}
