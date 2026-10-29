import { useMutation, useQueryClient } from '@tanstack/react-query';
import { collaborationApi, type CollaborationTask } from '../../api/collaboration';

export const defaultTaskDraft = { title: '', detail: '', criteria: '', effortHours: '1', dueDate: '', assigneeId: '', parentTaskId: '' };
export function useTaskOperations(projectId: string, draft: typeof defaultTaskDraft, dependencies: string[], graphRevision: number, onCreated: () => void) {
  const client = useQueryClient();
  const invalidate = async () => { await Promise.all(['collaboration-tasks', 'collaboration-proposals', 'tasks', 'task-graph', 'project-goal', 'task-focus', 'collaboration-task'].map(key => client.invalidateQueries({ queryKey: [key, projectId] }))); };
  const create = useMutation({ mutationFn: () => collaborationApi.createTask(projectId, {
    ...draft, title: draft.title.trim(), criteria: draft.criteria.trim(), effortHours: Number(draft.effortHours),
    parentTaskId: draft.parentTaskId || null, dueDate: draft.dueDate || null, assigneeId: draft.assigneeId || null, dependsOnTaskIds: dependencies, expectedGraphRevision: graphRevision,
  }), onSuccess: async () => { onCreated(); await invalidate(); }, onError: invalidate });
  const claim = useMutation({ mutationFn: (task: CollaborationTask) => collaborationApi.claim(projectId, task), onSuccess: invalidate, onError: invalidate });
  return { create, claim, invalidate };
}
