import { z } from '@hono/zod-openapi';
import type { Env } from '../env';
import { permissionDenied } from '../core/errors';

export const permissionSchema = z.object({ teamManage: z.boolean(), taskManage: z.boolean(), resourceManage: z.boolean(), scoreInitiate: z.boolean(), scoreCorrect: z.boolean().default(false) }).strict();
export type ProjectPermissions = z.infer<typeof permissionSchema>;
export type PermissionKey = keyof ProjectPermissions;
export const permissionKeys = ['teamManage', 'taskManage', 'resourceManage', 'scoreInitiate', 'scoreCorrect'] as const satisfies readonly PermissionKey[];
export const permissionLabels: Record<PermissionKey, string> = { teamManage: '团队管理', taskManage: '任务管理', resourceManage: '资料管理', scoreInitiate: '评分发起', scoreCorrect: '历史评分修正' };
export const memberPermissions: ProjectPermissions = { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true, scoreCorrect: false };
export const managerPermissions: ProjectPermissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };

/** 只解析已存 JSON，缺失字段回落到普通成员默认值；不判断 owner/admin 身份。 */
export function storedPermissions(stored: string | null): ProjectPermissions {
  let parsed: unknown;
  try { parsed = JSON.parse(stored ?? '{}'); } catch { parsed = {}; }
  const values = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(memberPermissions).map(([key, fallback]) => [key, typeof values[key] === 'boolean' ? values[key] : fallback])) as ProjectPermissions;
}
export function effectivePermissions(role: string, admin: boolean, stored: string | null): ProjectPermissions {
  if (role === 'owner' || admin) return { ...managerPermissions };
  return storedPermissions(stored);
}
/** 变更后新增授予的能力名称，用于审计通知文案；撤销不计入。 */
export function grantedPermissionLabels(previous: ProjectPermissions, next: ProjectPermissions): string[] {
  return permissionKeys.filter(key => next[key] && !previous[key]).map(key => permissionLabels[key]);
}

/**
 * 项目管理员谓词：项目 owner，或已加入该项目的平台 admin / super_admin。
 * 平台身份必须叠加项目成员资格，不能仅凭账号角色访问项目。
 * 该谓词只服务成员权限管理本身，不受 permissions_json 与 teamManage 影响。
 */
export function projectAdministratorSql(project: string, actor: string): string {
  return `EXISTS(SELECT 1 FROM project_members access LEFT JOIN auth_accounts account ON account.user_id=access.user_id WHERE access.project_id=${project} AND access.user_id=${actor} AND (access.role='owner' OR COALESCE(account.account_role,CASE WHEN account.is_admin=1 THEN 'admin' ELSE 'user' END) IN ('admin','super_admin')))`;
}
/** 项目负责人谓词：仅用于转让、核心项目配置、AI 自动协作规则等严格 owner-only 动作。 */
export function projectOwnerSql(project: string, actor: string): string {
  return `EXISTS(SELECT 1 FROM project_members owner_access WHERE owner_access.project_id=${project} AND owner_access.user_id=${actor} AND owner_access.role='owner')`;
}
/** SQL predicate is also used inside the write transaction, so revocations win races. */
export function projectPermissionSql(project: string, actor: string, permission: PermissionKey): string {
  const flag = `COALESCE(json_extract(access.permissions_json,'$.${permission}'),${permission === 'scoreInitiate' ? 1 : 0})=1`;
  return `EXISTS(SELECT 1 FROM project_members access LEFT JOIN auth_accounts account ON account.user_id=access.user_id WHERE access.project_id=${project} AND access.user_id=${actor} AND (access.role='owner' OR COALESCE(account.account_role,CASE WHEN account.is_admin=1 THEN 'admin' ELSE 'user' END) IN ('admin','super_admin') OR (${flag})))`;
}
export async function projectAccess(env: Env, projectId: string, userId: string) {
  const row = await env.DB.prepare(`SELECT m.role,m.permissions_json,m.permissions_revision,COALESCE(a.account_role,CASE WHEN a.is_admin=1 THEN 'admin' ELSE 'user' END) account_role FROM project_members m LEFT JOIN auth_accounts a ON a.user_id=m.user_id WHERE m.project_id=?1 AND m.user_id=?2`).bind(projectId,userId).first<{role:string;permissions_json:string;permissions_revision:number;account_role:string}>();
  if (!row) throw permissionDenied('不是项目成员');
  const admin = ['admin','super_admin'].includes(row.account_role);
  return { permissions: effectivePermissions(row.role,admin,row.permissions_json), permissionsRevision: row.permissions_revision, canManagePermissions: row.role === 'owner' || admin };
}
export async function requireProjectPermission(env: Env, projectId: string, userId: string, permission: PermissionKey) {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${projectPermissionSql('?1','?2',permission)}`).bind(projectId,userId).first()) throw permissionDenied('没有执行此操作的项目权限');
}
/** 成员权限管理入口：项目 owner 或本项目内的平台管理员；teamManage 本身不足以修改他人权限。 */
export async function canManageProjectPermissions(env: Env, projectId: string, userId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 WHERE ${projectAdministratorSql('?1','?2')}`).bind(projectId,userId).first());
}
export async function requireProjectAdministrator(env: Env, projectId: string, userId: string, message = '只有项目负责人或本项目内的平台管理员可以调整成员权限') {
  if (!await canManageProjectPermissions(env,projectId,userId)) throw permissionDenied(message);
}
export async function requireProjectOwner(env: Env, projectId: string, userId: string) {
  if (!await env.DB.prepare(`SELECT 1 WHERE ${projectOwnerSql('?1','?2')}`).bind(projectId,userId).first()) throw permissionDenied('需要项目负责人权限');
}
