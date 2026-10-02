import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { collaborationApi, type CollaborationTask } from '../api/collaboration';

export const taskSummarySource = (task: CollaborationTask) => task.detail.trim() || task.criteria.trim();
export function taskSummaryPreview(task: CollaborationTask) {
  const source = task.summary || taskSummarySource(task);
  const chars = Array.from(source);
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : source;
}
const signature = (task: CollaborationTask) => `${task.taskId}:${task.summarySourceHash ?? JSON.stringify([task.detail, task.criteria])}`;

export function useTaskSummaries(projectId: string, tasks: CollaborationTask[], enabled: boolean) {
  const client = useQueryClient();
  const attempted = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const latest = useRef(tasks);
  latest.current = tasks;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generation, setGeneration] = useState(0);
  const request = useCallback((task: CollaborationTask, retry = false) => {
    const key = signature(task);
    if (pending.current.has(key)) return;
    attempted.current.add(key);
    pending.current.add(key);
    setErrors(values => { const next = { ...values }; delete next[task.taskId]; return next; });
    void collaborationApi.summary(projectId, task.taskId, retry).then(async result => {
      // Do not apply a response to a task that has changed while the request ran.
      if (latest.current.some(item => signature(item) === key)) {
        client.setQueryData<{ items: CollaborationTask[] }>(['collaboration-tasks', projectId], data => data && ({ ...data, items: data.items.map(item => signature(item) === key ? { ...item, ...result } : item) }));
      }
      await client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] });
    }).catch(error => {
      if (latest.current.some(item => signature(item) === key)) setErrors(values => ({ ...values, [task.taskId]: error instanceof Error ? error.message : '摘要生成失败' }));
    }).finally(() => { pending.current.delete(key); setGeneration(value => value + 1); });
  }, [client, projectId]);
  useEffect(() => {
    if (!enabled) return;
    const running = tasks.filter(task => ['queued', 'running'].includes(task.summaryStatus ?? '') && !pending.current.has(signature(task))).length;
    let available = Math.max(0, 2 - running - pending.current.size);
    for (const task of tasks) {
      if (!available) break;
      if (Array.from(taskSummarySource(task)).length <= 60 || task.summary || ![undefined, 'missing'].includes(task.summaryStatus) || attempted.current.has(signature(task))) continue;
      available--; request(task);
    }
  }, [tasks, enabled, generation, request]);
  const active = tasks.some(task => task.summaryStatus === 'queued' || task.summaryStatus === 'running');
  useEffect(() => {
    if (!enabled || !active) return;
    const timer = window.setInterval(() => { if (!document.hidden) void client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }); }, 2500);
    return () => window.clearInterval(timer);
  }, [active, enabled, client, projectId]);
  return { errors, retryBusy: pending.current.size + tasks.filter(item => ['queued', 'running'].includes(item.summaryStatus ?? '')).length >= 2, retry: (task: CollaborationTask) => { if (enabled && pending.current.size + tasks.filter(item => ['queued', 'running'].includes(item.summaryStatus ?? '')).length < 2) request(task, true); } };
}
