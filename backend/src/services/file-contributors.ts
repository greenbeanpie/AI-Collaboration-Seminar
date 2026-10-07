import { z } from '@hono/zod-openapi';
import type { Env } from '../env';
export const contributorSchema = z.object({ userId: z.string().uuid(), displayName: z.string() });
export async function fileContributors(env: Env, projectId: string, fileId: string | null) {
  if (!fileId) return [];
  const rows = await env.DB.prepare(`SELECT c.user_id AS userId,c.display_name AS displayName
    FROM file_contributors c JOIN files f ON f.id=c.file_id WHERE f.id=?1 AND f.project_id=?2 ORDER BY c.display_name,c.user_id`)
    .bind(fileId,projectId).all<{userId:string;displayName:string}>();
  return rows.results;
}

/** One project-scoped query regardless of page size. JSON IDs avoid D1 bind limits. */
export async function fileContributorsForFiles(env: Env, projectId: string, fileIds: Array<string | null>) {
  const ids = [...new Set(fileIds.filter((id): id is string => Boolean(id)))];
  const groups = new Map<string, Array<{userId:string;displayName:string}>>();
  if (!ids.length) return groups;
  const rows = await env.DB.prepare(`SELECT c.file_id AS fileId,c.user_id AS userId,c.display_name AS displayName
    FROM file_contributors c JOIN files f ON f.id=c.file_id
    WHERE f.project_id=?1 AND f.id IN(SELECT value FROM json_each(?2)) ORDER BY c.display_name,c.user_id`)
    .bind(projectId,JSON.stringify(ids)).all<{fileId:string;userId:string;displayName:string}>();
  for (const {fileId,...contributor} of rows.results) {
    const list = groups.get(fileId) ?? []; list.push(contributor); groups.set(fileId,list);
  }
  return groups;
}
