import { QueryClient } from '@tanstack/react-query';
import { projectRequest } from '../api/simplification';
import type { DataOf } from '../api/types';

type Eligibility = DataOf<'TaskAgentEligibilityResponse'>;
type Key = readonly ['task-agent-eligibility', string, string, number];
type Entry = { key: Key; users: number; epoch: number; due: number; transition: string; since: number; checking: boolean };
type Pending = { entry: Entry; epoch: number; signal: AbortSignal; resolve: (value: Eligibility) => void; reject: (error: Error) => void };
type BatchResponse = DataOf<'TaskAgentEligibilityBatchResponse'>;
const clients = new WeakMap<QueryClient, Map<string, EligibilityCoordinator>>();

export function eligibilityPollDelay(status: string, elapsed: number) {
  if (status === 'missing') return 10_000;
  if (status === 'queued') return elapsed < 30_000 ? 5_000 : 10_000;
  if (status === 'running') return elapsed < 30_000 ? 2_000 : elapsed < 120_000 ? 5_000 : 10_000;
  return Infinity;
}

export function eligibilityCoordinator(client: QueryClient, projectId: string) {
  let projects = clients.get(client);
  if (!projects) { projects = new Map(); clients.set(client, projects); }
  let coordinator = projects.get(projectId);
  if (!coordinator) { coordinator = new EligibilityCoordinator(client, projectId); projects.set(projectId, coordinator); }
  return coordinator;
}

class EligibilityCoordinator {
  private entries = new Map<string, Entry>();
  private pending: Pending[] = [];
  private batches = new Set<{ controller: AbortController; pending: Pending[] }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  constructor(private client: QueryClient, private projectId: string) {}
  private active = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
  private identity(key: Key) { return `${key[2]}:${key[3]}`; }
  register(key: Key) {
    const id = this.identity(key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { key, users: 0, epoch: 0, due: Infinity, transition: '', since: Date.now(), checking: false };
      this.entries.set(id, entry);
    }
    entry.users++;
    if (!this.unsubscribe) {
      document.addEventListener('visibilitychange', this.environmentChanged);
      window.addEventListener('online', this.environmentChanged);
      window.addEventListener('offline', this.environmentChanged);
      this.unsubscribe = this.client.getQueryCache().subscribe(event => {
        if (event.type === 'removed' && event.query.queryKey[0] === 'task-agent-eligibility' && event.query.queryKey[1] === this.projectId) {
          const removed = this.entries.get(`${event.query.queryKey[2]}:${event.query.queryKey[3]}`);
          if (removed) this.remove(removed);
        }
      });
    }
    if (entry.users === 1 && this.active()) this.fetch(entry);
    const registered = entry;
    return () => { if (--registered.users === 0) this.remove(registered); };
  }
  private remove(entry: Entry) {
    entry.epoch++;
    if (this.entries.get(this.identity(entry.key)) === entry) {
      this.entries.delete(this.identity(entry.key));
      void this.client.cancelQueries({ queryKey: entry.key, exact: true });
    }
    for (const batch of this.batches) if (batch.pending.every(item => this.entries.get(this.identity(item.entry.key)) !== item.entry)) batch.controller.abort();
    if (!this.entries.size) {
      clearTimeout(this.flushTimer); this.flushTimer = undefined;
      for (const item of this.pending.splice(0)) item.reject(new Error('读取已取消'));
      document.removeEventListener('visibilitychange', this.environmentChanged);
      window.removeEventListener('online', this.environmentChanged);
      window.removeEventListener('offline', this.environmentChanged);
      this.unsubscribe?.(); this.unsubscribe = undefined;
    }
    this.schedule();
  }
  read(key: Key, signal: AbortSignal): Promise<Eligibility> {
    const entry = this.entries.get(this.identity(key));
    if (!entry || !this.active()) return Promise.reject(new Error('读取已暂停'));
    if (entry.checking) {
      const queued = this.client.getQueryData<Eligibility>(key);
      if (queued) return Promise.resolve(queued);
    }
    entry.due = Infinity;
    return new Promise((resolve, reject) => {
      this.pending.push({ entry, epoch: entry.epoch, signal, resolve, reject });
      this.flushTimer ??= setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, 0);
    });
  }
  async invalidate(key: Key) {
    const entry = this.entries.get(this.identity(key));
    if (entry) { entry.epoch++; entry.due = Infinity; }
    await this.client.cancelQueries({ queryKey: key, exact: true });
    this.schedule();
  }
  current(key: Key) {
    const entry = this.entries.get(this.identity(key));
    const epoch = entry?.epoch;
    return () => Boolean(entry && this.entries.get(this.identity(key)) === entry && entry.epoch === epoch);
  }
  checking(key: Key, checking: boolean) {
    const entry = this.entries.get(this.identity(key));
    if (entry) entry.checking = checking;
  }
  updated(key: Key, value: Eligibility) {
    const entry = this.entries.get(this.identity(key));
    if (!entry) return;
    const transition = `${value.taskRevision}:${value.jobId}:${value.status}`;
    if (entry.transition !== transition) { entry.transition = transition; entry.since = Date.now(); }
    entry.due = Date.now() + eligibilityPollDelay(value.status, Date.now() - entry.since);
    this.schedule();
  }
  private fetch(entry: Entry) {
    entry.due = Infinity;
    void this.client.fetchQuery({ queryKey: entry.key, queryFn: ({ signal }) => this.read(entry.key, signal), staleTime: 0, retry: false }).catch(() => {});
  }
  private async flush() {
    const pending = this.pending.splice(0);
    const valid = pending.filter(item => {
      if (item.signal.aborted || item.epoch !== item.entry.epoch || this.entries.get(this.identity(item.entry.key)) !== item.entry) { item.reject(new Error('读取已取消')); return false; }
      return true;
    });
    const groups = new Map<string, Pending[]>();
    for (const item of valid) { const group = groups.get(item.entry.key[2]) ?? []; group.push(item); groups.set(item.entry.key[2], group); }
    const taskIds = [...groups.keys()];
    for (let offset = 0; offset < taskIds.length; offset += 25) {
      const remaining = taskIds.slice(offset, offset + 25).flatMap(id => groups.get(id)!).filter(item => {
        if (!this.active() || item.signal.aborted || item.epoch !== item.entry.epoch || this.entries.get(this.identity(item.entry.key)) !== item.entry) { item.reject(new Error('读取已取消')); return false; }
        return true;
      });
      if (!remaining.length) continue;
      const ids = [...new Set(remaining.map(item => item.entry.key[2]))];
      const batch = { controller: new AbortController(), pending: remaining };
      this.batches.add(batch);
      try {
        const response = await projectRequest<BatchResponse>(this.projectId, `/collaboration/agent-eligibility?taskIds=${ids.map(encodeURIComponent).join(',')}`, { signal: batch.controller.signal, networkOnly: true });
        for (const item of batch.pending) {
          if (item.signal.aborted || item.epoch !== item.entry.epoch || this.entries.get(this.identity(item.entry.key)) !== item.entry) { item.reject(new Error('读取已取消')); continue; }
          const result = response.items.find(value => value.taskId === item.entry.key[2]);
          if (!result?.eligibility || result.errorCode) item.reject(new Error('任务不存在或已归档。'));
          else { this.updated(item.entry.key, result.eligibility); item.resolve(result.eligibility); }
        }
      } catch (error) {
        for (const item of batch.pending) item.reject(error instanceof Error ? error : new Error('适用性读取失败。'));
      } finally { this.batches.delete(batch); }
    }
    this.schedule();
  }
  private environmentChanged = () => {
    if (!this.active()) {
      for (const batch of this.batches) batch.controller.abort();
      for (const entry of this.entries.values()) { entry.epoch++; void this.client.cancelQueries({ queryKey: entry.key, exact: true }); }
    } else for (const entry of this.entries.values()) this.fetch(entry);
    this.schedule();
  };
  private schedule() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.active()) return;
    const due = Math.min(...[...this.entries.values()].map(entry => entry.due));
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const entry of this.entries.values()) if (entry.due <= Date.now() + 20) this.fetch(entry);
      this.schedule();
    }, Math.max(0, due - Date.now()));
  }
}
