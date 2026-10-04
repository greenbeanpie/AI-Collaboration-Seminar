import { useProject } from './components/ProjectShell';

/** 项目级操作能力；账户角色与项目身份都不在此处，避免出现平行权限体系。 */
export type ProjectPermissions = { teamManage: boolean; taskManage: boolean; resourceManage: boolean; scoreInitiate: boolean; scoreCorrect?: boolean };
export type PermissionKey = keyof ProjectPermissions;
export const permissionKeys = ['teamManage', 'taskManage', 'resourceManage', 'scoreInitiate', 'scoreCorrect'] as const satisfies readonly PermissionKey[];
export const ordinaryPermissions: ProjectPermissions = { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true, scoreCorrect: false };
/** 「协作管理员」只是前端 preset/template，不是数据库 role。 */
export const administratorPermissions: ProjectPermissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };
export const permissionLabels: Record<PermissionKey, string> = { teamManage: '团队管理', taskManage: '任务管理', resourceManage: '资料管理', scoreInitiate: '评分发起', scoreCorrect: '历史评分修正' };
export const permissionOptions: Array<{ key: PermissionKey; group: string; label: string; detail: string }> = [
  { key: 'teamManage', group: '团队', label: '管理团队成员', detail: '可以邀请成员、移除其他非负责人成员；不能调整成员权限' },
  { key: 'taskManage', group: '任务', label: '管理所有任务', detail: '可以创建、修改、分配任务和处理管理型操作' },
  { key: 'resourceManage', group: '资料', label: '管理所有资料', detail: '可以修改或删除其他成员创建的项目资料，并删除或恢复文件与来源' },
  { key: 'scoreInitiate', group: '评分', label: '发起评分与答辩', detail: '可以发起评分、检查与演练' },
  { key: 'scoreCorrect', group: '评分', label: '修正历史评分', detail: '可以人工修改已有评分结果' },
];
export type PermissionTemplate = 'ordinary' | 'manager' | 'custom';
export const permissionTemplates: Array<{ value: PermissionTemplate; label: string }> = [
  { value: 'ordinary', label: '普通成员' },
  { value: 'manager', label: '协作管理员' },
  { value: 'custom', label: '自定义' },
];

export function withTemplate(template: PermissionTemplate): ProjectPermissions {
  if (template === 'ordinary') return { ...ordinaryPermissions };
  if (template === 'manager') return { ...administratorPermissions };
  return { ...ordinaryPermissions };
}
export function permissionsEqual(a: ProjectPermissions, b: ProjectPermissions): boolean {
  return permissionKeys.every(key => Boolean(a[key]) === Boolean(b[key]));
}
export function permissionTemplate(permissions: ProjectPermissions): PermissionTemplate {
  if (permissionsEqual(permissions, ordinaryPermissions)) return 'ordinary';
  if (permissionsEqual(permissions, administratorPermissions)) return 'manager';
  return 'custom';
}
/** 普通成员默认能力之外的显式授予；用于权限摘要与「自定义」说明。 */
export function grantedPermissionKeys(permissions: ProjectPermissions): PermissionKey[] {
  return permissionKeys.filter(key => Boolean(permissions[key]) && !ordinaryPermissions[key]);
}
export function hasAllPermissions(permissions: ProjectPermissions): boolean {
  return permissionKeys.every(key => Boolean(permissions[key]));
}

/** owner 是项目身份；系统账号角色不参与项目权限判断。 */
export function isProjectOwner(project: { myRole: string }): boolean {
  return project.myRole === 'owner';
}
/** 成员权限管理仅属于项目 owner；忽略旧缓存中的管理员标志。 */
export function canManageProjectPermissions(project: { myRole: string; canManagePermissions?: boolean }): boolean {
  return isProjectOwner(project);
}
export function projectPermission(project: { myRole: string; permissions?: ProjectPermissions }, key: PermissionKey): boolean {
  return isProjectOwner(project) || Boolean(project.permissions?.[key] ?? ordinaryPermissions[key] ?? false);
}
export function effectiveProjectPermissions(project: { myRole: string; permissions?: ProjectPermissions }): ProjectPermissions {
  return Object.fromEntries(permissionKeys.map(key => [key, projectPermission(project, key)])) as ProjectPermissions;
}

/** 成员卡权限摘要：避免在列表中铺开五个 checkbox 状态。 */
export function permissionSummary(permissions: ProjectPermissions): string {
  if (hasAllPermissions(permissions)) return '协作管理员 · 全部权限';
  if (permissionsEqual(permissions, ordinaryPermissions)) return '普通成员 · 评分发起';
  const enabled = permissionKeys.filter(key => Boolean(permissions[key]));
  return enabled.length ? enabled.map(key => permissionLabels[key]).join(' · ') : '未授予项目操作权限';
}
export function memberRoleLabel(member: { role: string; isAdmin?: boolean; permissions?: ProjectPermissions }): string {
  if (member.role === 'owner') return '负责人';
  if (member.permissions && hasAllPermissions(member.permissions)) return '协作管理员';
  return '成员';
}
export function memberPermissionSummary(member: { role: string; isAdmin?: boolean; permissions?: ProjectPermissions }): string {
  if (member.role === 'owner') return '负责人 · 全部权限';
  return permissionSummary(member.permissions ?? ordinaryPermissions);
}

/** 统一入口：Team / Tasks / Materials / Assessment / AI 协作页面共用同一套判断。 */
export function useProjectPermissions() {
  const { projectId, project } = useProject();
  return {
    projectId,
    project,
    permissions: effectiveProjectPermissions(project),
    isOwner: isProjectOwner(project),
    canManagePermissions: canManageProjectPermissions(project),
    can: (key: PermissionKey) => projectPermission(project, key),
  };
}
