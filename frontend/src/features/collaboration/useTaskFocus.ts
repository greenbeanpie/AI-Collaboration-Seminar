import { useQuery } from '@tanstack/react-query';
import type { CollaborationTask } from '../../api/collaboration';
import { projectRequest } from '../../api/simplification';
export type FocusTask = CollaborationTask & { pinned: boolean; focusReasons: string[] };
export type TaskFocusResponse = { items: FocusTask[]; waitingReview: FocusTask[]; reviewRequired: FocusTask[] };
export function useTaskFocus(projectId: string) {
  return useQuery({ queryKey: ['task-focus', projectId], queryFn: async () => { const data = await projectRequest<TaskFocusResponse>(projectId, '/tasks/focus', { networkOnly: navigator.onLine !== false, offlineReadFallback: true }); if (!Array.isArray(data.items) || !Array.isArray(data.waitingReview) || !Array.isArray(data.reviewRequired)) throw new Error('重点任务响应不完整，请重试。'); return data; }, refetchInterval: 30_000 });
}
