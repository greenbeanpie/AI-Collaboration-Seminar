import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { adminRequest } from '../auth';
import { ErrorNotice, SectionCard, Spinner, StatusPill } from '../components/ui';

type RetryBatch = {
  batchId: string; status: 'queued' | 'running' | 'completed'; total: number; pending: number;
  queued: number; skipped: number; createdAt: string; updatedAt: string;
  skipReasons: { reason: string; count: number }[];
};
type RetryStatus = { failedCount: number; activeBatch: RetryBatch | null; latestBatch: RetryBatch | null };
type RetryResult = { batch: RetryBatch; replayed: boolean };
const batchLabels = { queued: '等待排队', running: '正在排队', completed: '排队完成' };

export function AdminAiRetries({ userId, superAdmin, onDenied }: { userId: string; superAdmin: boolean; onDenied: (error: unknown) => void }) {
  const client = useQueryClient();
  const key = useRef<string | null>(null);
  const submitting = useRef(false);
  const [denied, setDenied] = useState(false);
  function handleError(error: unknown) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      setDenied(true);
      key.current = null;
      client.removeQueries({ queryKey: ['admin-ai-retries'] });
      onDenied(error);
    }
  }
  const status = useQuery({
    queryKey: ['admin-ai-retries', userId, superAdmin], enabled: !denied, retry: false,
    queryFn: async () => {
      try { return await adminRequest<RetryStatus>('/api/v1/admin/ai-retries'); }
      catch (error) { handleError(error); throw error; }
    },
    refetchInterval: 10_000,
  });
  const enqueue = useMutation({
    mutationFn: () => adminRequest<RetryResult>('/api/v1/admin/ai-retries', { method: 'POST', body: { idempotencyKey: key.current } }),
    onSuccess: async () => { key.current = null; await client.invalidateQueries({ queryKey: ['admin-ai-retries'] }); },
    onError: handleError,
    onSettled: () => { submitting.current = false; },
    retry: false,
  });
  if (denied) return null;
  const active = status.data?.activeBatch;
  const batch = active ?? status.data?.latestBatch ?? enqueue.data?.batch;
  const disabled = !superAdmin || enqueue.isPending || status.isLoading || status.isFetching || status.isError || Boolean(active) || !status.data?.failedCount;
  return <SectionCard title="失败 AI 请求重试" detail="保留调用内的模型回退；失败后每隔 1 分钟重新请求，连续 3 次回退全部失败时自动停止。手动重试会重新开启停止的请求，并可能产生模型费用。">
    {status.isLoading && <Spinner label="正在读取失败 AI 请求" />}
    {status.error && <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />}
    {status.data && <p>当前失败请求：<strong>{status.data.failedCount}</strong></p>}
    <div className="button-row">
      {superAdmin ? <button type="button" className="button button-primary" disabled={disabled} onClick={() => {
        if (disabled || submitting.current) return;
        submitting.current = true;
        key.current ??= crypto.randomUUID();
        enqueue.mutate();
      }}>{enqueue.isPending ? '正在提交重试批次……' : '将所有失败请求排队重试'}</button> : <p className="muted">只有超级管理员可以将所有失败请求排队重试。</p>}
      <button type="button" className="button button-quiet" disabled={status.isFetching || enqueue.isPending} onClick={() => void status.refetch()}>刷新重试状态</button>
    </div>
    {enqueue.error !== null && <ErrorNotice error={enqueue.error} />}
    {enqueue.data && <p role="status">{enqueue.data.replayed ? '已读取原重试批次，未重复排队。' : '重试批次已提交。'}</p>}
    {batch && <div className="stack" role="status">
      <p><StatusPill tone={batch.status === 'completed' ? 'good' : 'blue'}>{batchLabels[batch.status]}</StatusPill> · 批次编号 <code>{batch.batchId}</code></p>
      <p>已排队 {batch.queued} / {batch.total} · 待处理 {batch.pending} · 已跳过 {batch.skipped}</p>
      {batch.skipReasons.length > 0 && <ul>{batch.skipReasons.map(item => <li key={item.reason}>{item.reason}：{item.count}</li>)}</ul>}
      <p className="muted">排队完成表示已交给后台重试，不代表 AI 请求已经成功。</p>
    </div>}
  </SectionCard>;
}
