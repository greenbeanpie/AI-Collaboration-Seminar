export type ProjectPermissions = { teamManage: boolean; taskManage: boolean; resourceManage: boolean; scoreInitiate: boolean };
export const ordinaryPermissions: ProjectPermissions = { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true };
export const administratorPermissions: ProjectPermissions = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true };
export function projectPermission(project: { myRole: string; permissions?: ProjectPermissions }, key: keyof ProjectPermissions): boolean {
  return project.myRole === 'owner' || (project.permissions?.[key] ?? ordinaryPermissions[key]);
}
