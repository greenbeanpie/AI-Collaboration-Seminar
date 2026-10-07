import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../../api/client';
import { collaborationApi } from '../../api/collaboration';
import { projectRequest, type ProjectGoal } from '../../api/simplification';
import { usePagedItems } from '../pagination/usePagedItems';
import type { FeedbackSnapshot } from './labels';

/** Project-level read models shared by task, inquiry and AI workflow views. */
export function useCollaborationQueries(projectId: string) {
  const feedback = useQuery({ queryKey: ['project-feedback', projectId], queryFn: () => projectRequest<FeedbackSnapshot>(projectId, '/collaboration/feedback/current') });
  const feedbackHistory = useQuery({ queryKey: ['project-feedback-history', projectId], queryFn: () => projectRequest<{ items: FeedbackSnapshot[] }>(projectId, '/collaboration/feedback/history') });
  const graph = useQuery({ queryKey: ['task-graph', projectId], queryFn: () => collaborationApi.graph(projectId) });
  const goal = useQuery({ queryKey: ['project-goal', projectId], queryFn: () => projectRequest<ProjectGoal>(projectId, '/goal') });
  const settings = useQuery({ queryKey: ['collaboration-settings', projectId], queryFn: () => collaborationApi.settings(projectId) });
  const members = usePagedItems<'MemberListResponse'>({ queryKey: ['members', projectId], path: projectPath(projectId, '/members'), searchable: true });
  const me = useQuery({ queryKey: ['member-me', projectId], queryFn: () => api.get<'MemberResponse'>(projectPath(projectId, '/members/me')) });
  const unread = useQuery({ queryKey: ['task-inquiries-unread', projectId], queryFn: () => projectRequest<{ items: { taskId: string; unreadCount: number }[] }>(projectId, '/task-inquiries/unread'), refetchInterval: 30_000 });
  return { feedback, feedbackHistory, graph, goal, settings, members, me, unread };
}
