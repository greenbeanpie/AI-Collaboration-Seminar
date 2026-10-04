import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import { projectRequest } from '../api/simplification';
import { useSession } from '../auth';
import { ErrorNotice, Spinner } from '../components/ui';
import { TaskAgentHandoff } from './TaskAgentHandoff';

export interface AssistancePlan {
  status: 'missing' | 'queued' | 'running' | 'ready' | 'failed' | 'disabled';
  taskRevision: number;
  sourceHash: string;
  plan: { markdown: string; generatedAt: string; sourceHash: string; stale: boolean } | null;
  jobId: string | null;
  error: string | null;
}

export function TaskAssistancePlan({ projectId, task }: { projectId: string; task: CollaborationTask }) {
  const client = useQueryClient();
  const session = useSession();
  const generationLock = useRef(false);
  const key = ['task-assistance-plan', projectId, task.taskId, task.revision, session.data?.id];
  const path = `/collaboration/tasks/${encodeURIComponent(task.taskId)}/assistance-plan`;
  const query = useQuery({ queryKey: key, retry: false, staleTime: 0,
    queryFn: ({ signal }) => projectRequest<AssistancePlan>(projectId, path, { signal, networkOnly: true }),
    refetchInterval: state => document.visibilityState !== 'hidden' && ['queued', 'running'].includes(state.state.data?.status ?? '') ? 1500 : false,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({ retry: false, mutationFn: async () => {
    const capturedKey = key;
    await client.cancelQueries({ queryKey: key });
    const result = await projectRequest<AssistancePlan>(projectId, path, { method: 'POST', body: { expectedRevision: task.revision, ...(query.data?.plan ? { regenerate: true } : {}) }, idempotencyKey: crypto.randomUUID(), networkOnly: true });
    return { capturedKey, result };
  }, onSuccess: ({ capturedKey, result }) => { client.setQueryData(capturedKey, result); } });
  const data = query.data;
  const pending = generate.isPending || data?.status === 'queued' || data?.status === 'running';
  const stale = data?.plan && (data.plan.stale || data.taskRevision !== task.revision);
  return <div className="stack">
    {query.isPending && <Spinner label="读取辅助计划" />}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {data?.plan && <><div className="task-assistance-plan">{data.plan.markdown}</div><small>生成于 {new Date(data.plan.generatedAt).toLocaleString()}</small></>}
    {stale && <p role="status">任务或项目资料已变化，当前计划需要更新。</p>}
    {pending && <Spinner label="正在生成辅助计划" />}
    {data?.error && <p role="alert">{data.error}</p>}
    {generate.error && <ErrorNotice error={generate.error} />}
    {data?.status === 'disabled' && <p role="status">AI 已禁用，暂不能生成计划。</p>}
    {data && !query.error && <button className="button button-primary" disabled={pending || data.status === 'disabled' || query.isFetching || data.taskRevision !== task.revision} onClick={() => {
      if (generationLock.current) return;
      generationLock.current = true;
      void generate.mutateAsync().catch(() => {}).finally(() => { generationLock.current = false; });
    }}>{data.plan ? '重新生成辅助计划' : '生成辅助计划'}</button>}
  </div>;
}

export function TaskAiAssistance({ projectId, task, tasks }: { projectId: string; task: CollaborationTask; tasks: CollaborationTask[] }) {
  const session = useSession();
  const contextKey = `${projectId}:${task.taskId}:${task.revision}:${session.data?.id ?? ''}`;
  return <div className="stack task-ai-assistance"><section className="stack" aria-label="辅助计划"><h3>辅助计划</h3><TaskAssistancePlan key={contextKey} projectId={projectId} task={task} /></section><section className="stack" aria-label="代实施"><h3>代实施</h3><TaskAgentHandoff key={contextKey} projectId={projectId} task={task} tasks={tasks} /></section></div>;
}
