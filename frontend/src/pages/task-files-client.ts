import { projectRequest } from '../api/simplification';
export type TaskFile = { materialId: string; fileId: string; name: string; revision: number; versionId: string; archivedAt: string | null; materialArchivedAt: string | null; deletedAt?: string | null; canManage: boolean; taskId: string; lifecycleVersion: number };
export const taskFilesKey = (projectId: string, taskId: string) => ['task-files', projectId, taskId];
export async function listTaskFiles(projectId: string, taskId: string): Promise<TaskFile[]> {
  // A cached empty list must not omit newly registered files from the next submission.
  return (await projectRequest<{ items: TaskFile[] }>(projectId, `/tasks/${taskId}/files`, { networkOnly: navigator.onLine !== false })).items;
}
export async function archiveFile(projectId: string, fileId: string, lifecycleVersion: number, restore: boolean) {
  return projectRequest(projectId, `/files/${fileId}/${restore ? 'unarchive' : 'archive'}`, { method: 'POST', body: { expectedLifecycleVersion: lifecycleVersion } });
}
export async function archiveMaterial(projectId: string, materialId: string, revision: number, restore: boolean) {
  return projectRequest(projectId, `/materials/${materialId}/${restore ? 'unarchive' : 'archive'}`, { method: 'POST', body: { expectedRevision: revision } });
}
