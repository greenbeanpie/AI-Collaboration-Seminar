import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import type { DataOf } from '../api/types';
import { projectRequest } from '../api/simplification';

export type TaskAgentEligibility = DataOf<'TaskAgentEligibilityResponse'>;
export const taskAgentEligibilityKey = (projectId: string, task: Pick<CollaborationTask, 'taskId' | 'revision'>) => ['task-agent-eligibility', projectId, task.taskId, task.revision] as const;

// Shared across card and dialog: a POST is always a deliberate user action.
export function useTaskAgentEligibility(projectId: string, task: CollaborationTask) {
  const client = useQueryClient();
  const key = taskAgentEligibilityKey(projectId, task);
  const path = `/collaboration/tasks/${encodeURIComponent(task.taskId)}/agent-eligibility`;
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => projectRequest<TaskAgentEligibility>(projectId, path, { signal, networkOnly: true }),
    retry: false,
    staleTime: 0,
    refetchInterval: state => visible && ['queued', 'running'].includes(state.state.data?.status ?? '') ? 1500 : false,
    refetchIntervalInBackground: false,
  });
  const check = useMutation({
    mutationKey: key,
    retry: false,
    mutationFn: async () => {
      const previous = client.getQueryData<TaskAgentEligibility>(key);
      if (previous?.status === 'queued' || previous?.status === 'running') return previous;
      // Cancel an older GET before writing the shared pending state.
      await client.cancelQueries({ queryKey: key });
      const current = client.getQueryData<TaskAgentEligibility>(key);
      if (current?.status === 'queued' || current?.status === 'running') return current;
      client.setQueryData<TaskAgentEligibility>(key, { status: 'queued', taskRevision: task.revision, sourceHash: '', eligible: null, reason: null, jobId: null });
      try {
        const result = await projectRequest<TaskAgentEligibility>(projectId, path, { method: 'POST', body: { expectedRevision: task.revision, ...(current?.status === 'failed' ? { retry: true } : {}) }, networkOnly: true, idempotencyKey: crypto.randomUUID() });
        client.setQueryData(key, result);
        return result;
      } catch (error) {
        client.setQueryData<TaskAgentEligibility>(key, { status: 'failed', taskRevision: task.revision, sourceHash: '', eligible: null, reason: error instanceof Error ? error.message : '检查请求失败，请重试。', jobId: null });
        throw error;
      }
    },
  });
  const result = query.data;
  const revisionMatches = result?.taskRevision === task.revision;
  const eligible = !query.error && !query.isFetching && !check.isPending && revisionMatches && result?.status === 'ready' && result.eligible === true && Boolean(result.sourceHash);
  const pending = check.isPending || (revisionMatches && (result?.status === 'queued' || result?.status === 'running'));
  const reason = query.error ? '无法读取 AI 适用性判断，请重试读取。'
    : result && !revisionMatches ? '任务已更新，请刷新任务列表后重新检查 AI 适用性。'
    : result?.status === 'disabled' ? (result.reason || '当前 AI 服务不可用，暂不能检查任务适用性。')
    : pending ? 'AI 正在判断任务能否完整执行，请稍候。'
    : result?.status === 'failed' ? (result.reason || 'AI 适用性检查失败，请重试检查。')
    : result?.status === 'ready' && result.eligible === false ? (result.reason || 'AI 判断此任务需要真人参与，不能整项交给 AI。')
    : !eligible ? '请先检查 AI 适用性，通过后可交给本地 Agent。' : result?.reason;
  return { eligible, pending, reason, result, loading: query.isPending || query.isFetching, check: () => void check.mutateAsync().catch(() => {}), reload: () => void query.refetch(), readError: Boolean(query.error), canCheck: !query.isPending && !query.error && !query.isFetching && !pending && revisionMatches && result?.status !== 'disabled' && result?.status !== 'ready', retry: result?.status === 'failed' };
}
