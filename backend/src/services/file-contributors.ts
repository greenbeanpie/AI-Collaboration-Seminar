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
