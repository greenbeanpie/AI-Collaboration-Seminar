import { executionOf, olderExecution } from '../api/ai-execution';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Job } from '../api/types';
import type { ActivityJob } from '../api/ai-activity';
import '../styles/ai-workflows.css';

export type JobPollState = {
  job: ActivityJob | null;
  error: unknown;
  loading: boolean;
};

const pollDelays = [2_000, 3_000, 5_000, 8_000, 10_000];

/** Poll a real backend job while this page is visible, starting at two seconds and backing off to ten. */
export function useVisibleJobPoller(jobId: string | null, refreshKey = 0) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<{ jobId: string | null } & JobPollState>({ jobId: null, job: null, error: null, loading: false });

  useEffect(() => {
    if (!jobId) {
      setState({ jobId: null, job: null, error: null, loading: false });
      return;
    }

    let active = true;
    let polledId = jobId;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let delayIndex = 0;
    let inFlight = false;
    let refreshWhenVisible = false;
    setState(current => ({ jobId, job: current.jobId === jobId ? current.job : null, error: null, loading: true }));

    const schedule = () => {
      if (!active || document.visibilityState !== 'visible') return;
      if (timer !== undefined) window.clearTimeout(timer);
      const delay = pollDelays[Math.min(delayIndex, pollDelays.length - 1)] ?? 10_000;
      delayIndex += 1;
      timer = window.setTimeout(() => { void poll(); }, delay);
    };

    const poll = async () => {
      if (!active || document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const job = await api.get<'JobResponse'>(`/api/v1/jobs/${encodeURIComponent(polledId)}`, undefined, controller.signal);
        polledId = job.jobId;
        if (!active) return;
        setState(current => olderExecution(job, current.job) ? current : { jobId, job, error: null, loading: false });
        if (!isSettledJob(job.status) && executionOf(job)?.state !== 'paused') schedule();
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState((current) => current.jobId === jobId ? { ...current, error, loading: false } : current);
        schedule();
      } finally {
        inFlight = false;
        controller = undefined;
        if (refreshWhenVisible && active && document.visibilityState === 'visible') {
          refreshWhenVisible = false;
          void poll();
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        controller?.abort();
      } else if (!inFlight) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        void poll();
      } else refreshWhenVisible = true;
    };

    const onRefresh = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (inFlight) refreshWhenVisible = true; else void poll();
    };
    window.addEventListener('ai-job-refresh', onRefresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.visibilityState === 'visible') void poll();
    return () => {
      active = false;
      window.removeEventListener('ai-job-refresh', onRefresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [jobId, refreshKey, refreshVersion]);

  const current: JobPollState & { jobId: string | null } = state.jobId === jobId
    ? { jobId: state.jobId, job: state.job, error: state.error, loading: state.loading }
    : { jobId, job: null, error: null, loading: Boolean(jobId) };
  return {
    ...current,
    refresh: () => setRefreshVersion(version => version + 1),
    isSettled: current.job ? isSettledJob(current.job.status) : false,
  };
}

export function isSettledJob(status: Job['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'waiting_input';
}

export function jobStatusLabel(status: Job['status']): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '处理中';
    case 'waiting_input': return '等待补充信息';
    case 'succeeded': return '已完成';
    case 'failed': return '执行失败';
    case 'cancelled': return '已取消';
  }
}

type StoredIntent = { signature: string; key: string };
const intentFallback = new Map<string, StoredIntent>();

async function fingerprint(value: unknown): Promise<string> {
  const serialized = JSON.stringify(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return serialized;
}

/** Keeps one key for unchanged request input, including a retry after a page reload in the same tab. */
export async function idempotencyKeyForIntent(namespace: string, input: unknown): Promise<string> {
  const signature = await fingerprint(input);
  const storageKey = `ai-office:intent:${namespace}`;
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<StoredIntent>;
      if (parsed.signature === signature && typeof parsed.key === 'string') {
        intentFallback.set(namespace, { signature, key: parsed.key });
        return parsed.key;
      }
    }
  } catch { /* Private browsing can disable session storage; the in-memory key still covers retries. */ }
  const cached = intentFallback.get(namespace);
  if (cached?.signature === signature) return cached.key;
  const key = globalThis.crypto?.randomUUID?.() ?? `intent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  intentFallback.set(namespace, { signature, key });
  try { sessionStorage.setItem(storageKey, JSON.stringify({ signature, key } satisfies StoredIntent)); }
  catch { /* Keep the stable key in memory for this page lifetime. */ }
  return key;
}

export function completeIntent(namespace: string): void {
  intentFallback.delete(namespace);
  try { sessionStorage.removeItem(`ai-office:intent:${namespace}`); }
  catch { /* Storage may be unavailable. */ }
}

export async function retryBackendJob(projectId: string, jobId: string): Promise<string> {
  const namespace = `job-retry:${projectId}:${jobId}`;
  const input = { jobId };
  const key = await idempotencyKeyForIntent(namespace, input);
  const result = await api.post<'JobRetryResponse'>(`/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, undefined, { idempotencyKey: key });
  completeIntent(namespace);
  return result.jobId;
}

export function readRecentIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string').slice(0, 5);
  } catch { /* Invalid local state is treated as no recent IDs. */ }
  return [];
}

export function writeRecentId(key: string, id: string): string[] {
  const ids = [id, ...readRecentIds(key).filter((current) => current !== id)].slice(0, 5);
  try { localStorage.setItem(key, JSON.stringify(ids)); }
  catch { /* The server response remains usable even when local recent-session storage is unavailable. */ }
  return ids;
}

export function readPendingJob<T extends { jobId: string; entityId: string; action: string }>(key: string): T | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object') {
      const candidate = value as Partial<T>;
      if (typeof candidate.jobId === 'string' && typeof candidate.entityId === 'string' && typeof candidate.action === 'string') return candidate as T;
    }
  } catch { /* Invalid local state is treated as no pending job. */ }
  return null;
}

export function writePendingJob(key: string, value: { jobId: string; entityId: string; action: string }): void {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Polling continues in memory for this page visit. */ }
}

export function clearPendingJob(key: string, jobId: string): void {
  try {
    const stored = readPendingJob<{ jobId: string; entityId: string; action: string }>(key);
    if (stored?.jobId === jobId) localStorage.removeItem(key);
  } catch { /* Storage may be unavailable. */ }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatWorkflowDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function markdownToTiptapDoc(markdown: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  type MarkdownList = { type: 'bulletList' | 'orderedList'; items: string[] };
  const listState: { value: MarkdownList | null } = { value: null };
  const inlineNodes = (text: string): Record<string, unknown>[] => text ? [{ type: 'text', text }] : [];
  const flushList = (value: MarkdownList | null) => {
    if (!value) return;
    content.push({ type: value.type, content: value.items.map((text) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inlineNodes(text) }] })) });
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const ordered = line.match(/^(\d+)[.、)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (bullet || ordered) {
      const nextType = bullet ? 'bulletList' : 'orderedList';
      if (listState.value?.type !== nextType) { flushList(listState.value); listState.value = { type: nextType, items: [] }; }
      listState.value?.items.push((bullet?.[1] ?? ordered?.[2] ?? '').trim());
      continue;
    }
    flushList(listState.value);
    listState.value = null;
    if (heading) content.push({ type: 'heading', attrs: { level: heading[1]?.length ?? 1 }, content: inlineNodes((heading[2] ?? '').trim()) });
    else if (quote) content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineNodes((quote[1] ?? '').trim()) }] });
    else if (line.trim()) content.push({ type: 'paragraph', content: inlineNodes(line.trim()) });
  }
  flushList(listState.value);
  return { type: 'doc', content };
}
