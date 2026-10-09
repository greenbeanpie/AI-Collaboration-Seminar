import { errorMessage } from '../api/error-info';
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import type { DataOf } from '../api/types';
import { projectRequest } from '../api/simplification';
import { eligibilityCoordinator } from './task-agent-eligibility-coordinator';

export type TaskAgentEligibility = DataOf<'TaskAgentEligibilityResponse'>;
export const taskAgentEligibilityKey = (projectId: string, task: Pick<CollaborationTask, 'taskId' | 'revision'>) => ['task-agent-eligibility', projectId, task.taskId, task.revision] as const;

// Shared across card and dialog: a POST is always a deliberate user action.
export function useTaskAgentEligibility(projectId: string, task: CollaborationTask) {
  const client = useQueryClient();
  const key = taskAgentEligibilityKey(projectId, task);
  const path = `/collaboration/tasks/${encodeURIComponent(task.taskId)}/agent-eligibility`;
  const coordinator = eligibilityCoordinator(client, projectId);
  useEffect(() => coordinator.register(['task-agent-eligibility', projectId, task.taskId, task.revision]), [coordinator, projectId, task.taskId, task.revision]);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => coordinator.read(key, signal),
    enabled: false,
    retry: false,
    staleTime: Infinity,
  });
  const check = useMutation({
    mutationKey: key,
    retry: false,
    mutationFn: async () => {
      const previous = client.getQueryData<TaskAgentEligibility>(key);
      if (previous?.status === 'queued' || previous?.status === 'running') return previous;
      // Cancel an older GET before writing the shared pending state.
      await coordinator.invalidate(key);
      const currentRequest = coordinator.current(key);
      if (!currentRequest()) throw new Error('检查已取消');
      const current = client.getQueryData<TaskAgentEligibility>(key);
      if (current?.status === 'queued' || current?.status === 'running') return current;
      coordinator.checking(key, true);
      client.setQueryData<TaskAgentEligibility>(key, { status: 'queued', taskRevision: task.revision, sourceHash: '', eligible: null, reason: null, jobId: null });
      try {
        const result = await projectRequest<TaskAgentEligibility>(projectId, path, { method: 'POST', body: { expectedRevision: task.revision, ...(current?.status === 'failed' ? { retry: true } : {}) }, networkOnly: true, idempotencyKey: crypto.randomUUID() });
        if (currentRequest()) {
          client.setQueryData(key, result);
          coordinator.updated(key, result);
        }
        return result;
      } catch (error) {
        if (currentRequest()) client.setQueryData<TaskAgentEligibility>(key, { status: 'failed', taskRevision: task.revision, sourceHash: '', eligible: null, reason: error instanceof Error ? error.message : '检查请求失败，请重试。', jobId: null });
        throw error;
      } finally {
        if (currentRequest()) coordinator.checking(key, false);
      }
    },
  });
  const result = query.data;
  const revisionMatches = result?.taskRevision === task.revision;
  const eligible = !query.error && !query.isFetching && !check.isPending && revisionMatches && result?.status === 'ready' && result.eligible === true && Boolean(result.sourceHash);
  const pending = check.isPending || (revisionMatches && (result?.status === 'queued' || result?.status === 'running'));
  const reason = query.error ? errorMessage(query.error)
    : result && !revisionMatches ? '任务已更新，正在等待最新适用性判断。'
    : result?.status === 'disabled' ? '当前 AI 服务不可用，暂不能代实施。'
    : pending ? 'AI 正在判断任务能否完整执行，请稍候。'
    : result?.status === 'failed' ? result.reason ?? '自动检查失败，可重试。'
    : result?.status === 'ready' && result.eligible === false ? '此任务暂不支持代实施。'
    : !eligible ? 'AI 正在自动检查适用性，完成后可代实施。' : undefined;
  return { eligible, pending, reason, result, loading: query.isPending || query.isFetching, check: () => void check.mutateAsync().catch(() => {}), reload: () => void query.refetch(), readError: Boolean(query.error), canCheck: !query.isPending && !query.error && !query.isFetching && !pending && revisionMatches && result?.status === 'failed', retry: result?.status === 'failed' };
}
