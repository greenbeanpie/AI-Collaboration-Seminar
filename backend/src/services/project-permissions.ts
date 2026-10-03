import { z } from '@hono/zod-openapi';
import type { Env } from '../env';
import { permissionDenied } from '../core/errors';

export const permissionSchema = z.object({ teamManage: z.boolean(), taskManage: z.boolean(), resourceManage: z.boolean(), scoreInitiate: z.boolean(), scoreCorrect: z.boolean().default(false) }).strict();
export type ProjectPermissions = z.infer<typeof permissionSchema>;
export type PermissionKey = keyof ProjectPermissions;
export const memberPermissions: ProjectPermissions = { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true, scoreCorrect: false };
export const managerPermissions: ProjectPermissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };
export function effectivePermissions(role: string, admin: boolean, stored: string | null): ProjectPermissions {
  if (role === 'owner' || admin) return { ...managerPermissions };
  let parsed: unknown;
  try { parsed = JSON.parse(stored ?? '{}'); } catch { parsed = {}; }
  const values = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(memberPermissions).map(([key, fallback]) => [key, typeof values[key] === 'boolean' ? values[key] : fallback])) as ProjectPermissions;
}
/** SQL predicate is also used inside the write transaction, so revocations win races. */
export function projectPermissionSql(project: string, actor: string, permission: PermissionKey | 'grant'): string {
  const flag = permission === 'grant' ? '0' : `COALESCE(json_extract(access.permissions_json,'$.${permission}'),${permission === 'scoreInitiate' ? 1 : 0})=1`;
  return `EXISTS(SELECT 1 FROM project_members access LEFT JOIN auth_accounts account ON account.user_id=access.user_id WHERE access.project_id=${project} AND access.user_id=${actor} AND (access.role='owner' OR COALESCE(account.account_role,CASE WHEN account.is_admin=1 THEN 'admin' ELSE 'user' END) IN ('admin','super_admin') OR (${flag})))`;
}
export async function projectAccess(env: Env, projectId: string, userId: string) {
  const row = await env.DB.prepare(`SELECT m.role,m.permissions_json,m.permissions_revision,COALESCE(a.account_role,CASE WHEN a.is_admin=1 THEN 'admin' ELSE 'user' END) account_role FROM project_members m LEFT JOIN auth_accounts a ON a.user_id=m.user_id WHERE m.project_id=?1 AND m.user_id=?2`).bind(projectId,userId).first<{role:string;permissions_json:string;permissions_revision:number;account_role:string}>();
  if (!row) throw permissionDenied('不是项目成员');
  const admin = ['admin','super_admin'].includes(row.account_role);
  return { permissions: effectivePermissions(row.role,admin,row.permissions_json), permissionsRevision: row.permissions_revision, canGrantPermissions: row.role === 'owner' || admin };
}
export async function requireProjectPermission(env: Env, projectId: string, userId: string, permission: PermissionKey | 'grant') {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${projectPermissionSql('?1','?2',permission)}`).bind(projectId,userId).first()) throw permissionDenied('没有执行此操作的项目权限');
}
