export type ProjectPermissions = { teamManage: boolean; taskManage: boolean; resourceManage: boolean; scoreInitiate: boolean; scoreCorrect?: boolean };
export const ordinaryPermissions: ProjectPermissions = { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true, scoreCorrect: false };
export const administratorPermissions: ProjectPermissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };
export function projectPermission(project: { myRole: string; permissions?: ProjectPermissions }, key: keyof ProjectPermissions): boolean {
  return project.myRole === 'owner' || (project.permissions?.[key] ?? ordinaryPermissions[key] ?? false);
}
