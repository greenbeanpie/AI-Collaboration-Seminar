import { ExecutionControlPanel } from './ExecutionControlPanel';
import { executionOf } from '../api/ai-execution';
import { useEffect, useRef, useState } from 'react';
import { activityLabel, activityTime, readActivityEvents, type ActivityJob, type AiActivity, type AiActivityEvent } from '../api/ai-activity';
import { errorMessage } from '../api/error-info';
import { ErrorNotice } from './ui';
import './ai-activity.css';

type Props = {
  job?: ActivityJob | null; activity?: AiActivity | null; status?: ActivityJob['status']; jobId?: string;
  eventsPath?: string; submitting?: boolean; loading?: boolean; readError?: unknown; onRefresh?: () => void;
  onResume?: () => void | Promise<void>; resuming?: boolean; executionEnabled?: boolean; showHistory?: boolean;
};
const statuses: Record<ActivityJob['status'], string> = { queued: '排队中', running: 'AI 处理中', waiting_input: '等待补充信息', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const eventStates = { started: '开始', completed: '完成', failed: '失败', resumed: '继续执行' };

export function AiActivityStatus({ job, activity: suppliedActivity, status: suppliedStatus, jobId: suppliedId, eventsPath, submitting = false, loading = false, readError, onRefresh, onResume, resuming = false, executionEnabled = true, showHistory = true }: Props) {
  const activity = suppliedActivity ?? job?.activity;
  const status = suppliedStatus ?? job?.status;
  const jobId = suppliedId ?? job?.jobId;
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<{ jobId?: string; items: AiActivityEvent[]; cursor: number | null; loaded: boolean }>({ items: [], cursor: null, loaded: false });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);
  const resumeLock = useRef(false);
  const currentHistory = history.jobId === jobId ? history : { items: [], cursor: null, loaded: false };
  useEffect(() => {
    if (!open || !jobId || (history.jobId === jobId && history.loaded)) return;
    const controller = new AbortController();
    setHistoryLoading(true); setHistoryError(null);
    void readActivityEvents(jobId, undefined, controller.signal, eventsPath).then(page => { if (controller.signal.aborted) return; setHistoryLoading(false); setHistory({ jobId, items: page.items, cursor: page.nextCursor, loaded: true }); }).catch(error => {
      if (!controller.signal.aborted) setHistoryError(error);
    }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [open, jobId, eventsPath, history.jobId, history.loaded]);
  const historyRef = useRef(history);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => {
    const history = historyRef.current;
    if (!open || !jobId || history.jobId !== jobId || !history.loaded || history.cursor !== null || !activity?.updatedAt) return;
    const controller = new AbortController();
    const cursor = history.items.at(-1)?.id;
    void readActivityEvents(jobId, cursor, controller.signal, eventsPath).then(page => {
      if (controller.signal.aborted || !page.items.length) return;
      setHistory(current => current.jobId !== jobId ? current : { ...current, items: [...current.items, ...page.items.filter(item => !current.items.some(previous => previous.id === item.id))], cursor: page.nextCursor });
    }).catch(error => { if (!controller.signal.aborted) setHistoryError(error); });
    return () => controller.abort();
  }, [open, jobId, activity?.updatedAt, eventsPath]);
  if (!job && !activity && !status && !submitting && !loading && !readError) return null;
  const executing = status === 'running' && !readError;
  const progress = activity?.progress;
  const result = job?.result as { partial?: boolean; complete?: boolean; summary?: string; caveats?: string[]; fragments?: Array<{ id: string; page_number: number | null; content: string }> } | null;
  const partial = result && typeof result === 'object' && result.partial === true && result.complete === false;

  const resume = async () => {
    if (!onResume || resumeLock.current || resuming) return;
    resumeLock.current = true; setResumePending(true); setResumeError(null);
    try { await onResume(); } catch (error) { setResumeError(error); }
    finally { resumeLock.current = false; setResumePending(false); }
  };
  const loadMore = async () => {
    if (!jobId || historyLoading) return;
    setHistoryLoading(true); setHistoryError(null);
    try {
      const page = await readActivityEvents(jobId, currentHistory.cursor ?? undefined, undefined, eventsPath);
      setHistory(current => ({ jobId, items: [...(current.jobId === jobId && current.loaded ? current.items : []), ...page.items], cursor: page.nextCursor, loaded: true }));
    } catch (error) { setHistoryError(error); } finally { setHistoryLoading(false); }
  };
  return <section className="ai-activity" aria-label="AI 处理状态">
    <div className="ai-activity-current" role="status" aria-live="polite" aria-atomic="true">
      <span className={`ai-activity-indicator${executing ? ' is-running' : ''}`} aria-hidden="true" />
      <div><strong>{resuming || resumePending ? '等待续跑' : executionOf(job)?.state === 'paused' ? '已暂停' : activity?.code === 'waiting_retry' ? '等待重试' : status ? statuses[status] : submitting ? '提交 AI 请求' : loading ? '读取 AI 状态' : '等待任务状态'}</strong>
        <p>当前操作：{submitting && !job ? '提交请求' : activity ? activityLabel(activity.code) : status === 'queued' ? '等待执行' : status === 'succeeded' ? '已完成' : '等待服务端状态'}{progress && ` · 已完成 ${progress.completed}${typeof progress.total === 'number' ? ` / ${progress.total}` : ''}${progress.unit === 'page' ? ' 页' : progress.unit === 'chunk' ? ' 块' : progress.unit === 'window' ? ' 窗口' : ' 步'}`}</p>
        <p>AI 最后一次回复时间：<time dateTime={activity?.lastResponseAt ?? undefined}>{activityTime(activity?.lastResponseAt)}</time></p>
      </div>
    </div>
    {Boolean(readError) && <div><p>读取状态失败，保留最近一次已知状态。</p><ErrorNotice error={readError} onRetry={onRefresh} /></div>}
    {status === 'failed' && <div><p className="ai-activity-failure">{errorMessage(job?.error, 'AI 执行失败。')}</p>{activity?.uncertain && <p>上次请求结果不明，继续时将重新请求未完成步骤，可能再次计费。</p>}{activity?.canResume && onResume && executionOf(job)?.state !== 'paused' ? <button className="button button-quiet button-small" disabled={resuming || resumePending} onClick={() => void resume()}>{resuming || resumePending ? '正在续跑' : '从停止处继续'}</button> : <p>{activity?.resumeReason ?? '此任务暂不可续跑，请重新发起。'}</p>}</div>}
    {job && jobId && <ExecutionControlPanel execution={executionOf(job)} enabled={executionEnabled} path={`/api/v1/jobs/${encodeURIComponent(jobId)}`} onUpdated={() => { onRefresh?.(); window.dispatchEvent(new Event('ai-job-refresh')); }} />}
    {status === 'succeeded' && partial && <section aria-label="部分 AI 结果"><p role="status">已输出当前部分结果；尚未处理的范围仍未完成，不能视为全文处理成功。</p>{result.caveats?.filter(value => typeof value === 'string').map((value, index) => <p key={index}>{value}</p>)}{typeof result.summary === 'string' && result.summary && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.summary}</pre>}{Array.isArray(result.fragments) && <details><summary>已识别的正文片段</summary>{result.fragments.map(fragment => <div key={fragment.id}>{fragment.page_number !== null && <p>第 {fragment.page_number} 页</p>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{fragment.content}</pre></div>)}</details>}</section>}
    {Boolean(resumeError) && <ErrorNotice error={resumeError} />}
    {showHistory && jobId && <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>操作记录</summary>
      {currentHistory.items.length > 0 && <ol className="ai-activity-history">{currentHistory.items.map(event => <li key={event.id}><span>{activityLabel(event.code)} · {eventStates[event.state]}{event.progress ? ` · 已完成 ${event.progress.completed}${event.progress.total !== undefined ? ` / ${event.progress.total}` : ''}` : ''}</span><time dateTime={event.at}>{activityTime(event.at)}</time></li>)}</ol>}
      {historyLoading && <p role="status">读取操作记录…</p>}
      {Boolean(historyError) && <ErrorNotice error={historyError} onRetry={() => void loadMore()} />}
      {currentHistory.loaded && !currentHistory.items.length && <p>尚无操作记录。</p>}
      {currentHistory.cursor !== null && <button className="button button-quiet button-small" disabled={historyLoading} onClick={() => void loadMore()}>加载更多记录</button>}
    </details>}
  </section>;
}
