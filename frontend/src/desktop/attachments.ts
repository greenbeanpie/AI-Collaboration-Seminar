import { desktopInvoke, isDesktop } from './bridge';

export type DesktopFile = {
  id: string; accountId: string; projectId: string; taskId?: string; replaceMaterialId?: string;
  expectedRevision?: number; fileId?: string; name: string; sizeBytes: number;
  direction: 'upload' | 'download'; status: 'waiting' | 'transferring' | 'paused' | 'failed' | 'complete';
  transferredBytes: number; error?: string;
};
export type CacheFile = { fileId: string; name: string; sizeBytes: number };
export const listDesktopFiles = (projectId: string) => desktopInvoke<DesktopFile[]>('desktop_list_files', { projectId });
export const stageDesktopFiles = (projectId: string, taskId?: string, replaceMaterialId?: string, expectedRevision?: number, maxFiles = 10) =>
  desktopInvoke<DesktopFile[]>('desktop_stage_files', { projectId, taskId, replaceMaterialId, expectedRevision, maxFiles });
export async function transferDesktopFiles(projectId: string) {
  await desktopInvoke<void>('desktop_transfer_files', { projectId });
  window.dispatchEvent(new CustomEvent('desktop-transfer-refresh', { detail: { projectId } }));
}
export const pendingDesktopFiles = () => desktopInvoke<{ pendingUploads: number }>('desktop_pending_files');
export const cacheProjectFiles = (projectId: string, files: CacheFile[]) => desktopInvoke<DesktopFile[]>('desktop_cache_project', { projectId, files });
export const pauseDesktopFile = (projectId: string, id: string) => desktopInvoke<void>('desktop_pause_file', { projectId, id });
export const resumeDesktopFile = (projectId: string, id: string) => desktopInvoke<void>('desktop_resume_file', { projectId, id });
export const removeDesktopFile = (projectId: string, id: string, discard = false) => desktopInvoke<void>('desktop_remove_file', { projectId, id, discard });
export const exportDesktopFile = (projectId: string, id: string) => desktopInvoke<void>('desktop_export_file', { projectId, id });
export async function hasPendingTaskFiles(projectId: string, taskId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return (await listDesktopFiles(projectId)).some(row => row.direction === 'upload' && row.taskId === taskId && row.status !== 'complete');
}
export const hasPendingTaskAttachments = hasPendingTaskFiles;
export function estimateCache(files: CacheFile[]) { return { count: files.length, sizeBytes: files.reduce((n, file) => n + file.sizeBytes, 0) }; }
