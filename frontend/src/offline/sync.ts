import { ApiError, request } from '../api/client';
import { offlineAccount, operations, putOperation, readSnapshot, removeOperation, snapshots, writeSnapshot, type PendingOperation } from './store';
import { replaceLocalIds } from './queue';

let syncing: Promise<void> | undefined;
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function mergeUnchangedFields(base: unknown, current: unknown, patch: Record<string, unknown>): Record<string, unknown> | null {
  const old = object(base), server = object(current);
  if (!Number.isInteger(server.revision)) return null;
  const fields = Object.keys(patch).filter(key => key !== 'expectedRevision');
  if (!fields.length || fields.some(key => JSON.stringify(old[key]) !== JSON.stringify(server[key]) && JSON.stringify(patch[key]) !== JSON.stringify(server[key]))) return null;
  return { ...patch, expectedRevision: server.revision };
}
async function currentEntity(row: PendingOperation): Promise<unknown> {
  const path = row.url.replace('/collaboration/tasks/', '/tasks/').replace(/\/(?:claim|submissions)$/, '');
  return request<'ProjectResponse'>(path, { networkOnly: true });
}
async function performSync(): Promise<void> {
  if (!navigator.onLine) return;
  const account = offlineAccount();
  if (!account) return;
  if (!(await operations(account.id)).length) return;
  // An offline identity is only a local reading context, never proof of current server authority.
  const session = await request<'AuthSessionGetResponse'>('/auth/session', { networkOnly: true });
  if (session.user.id !== account.id) return;
  const blockedProjects = new Set<string>();
  for (const original of await operations(account.id)) {
    if (!navigator.onLine || offlineAccount()?.id !== account.id) break;
    if (original.state !== 'pending') { blockedProjects.add(original.projectId); continue; }
    if (blockedProjects.has(original.projectId)) continue;
    // Re-read after earlier creates may have replaced local IDs in dependent intents.
    const row = (await operations(account.id)).find(item => item.key === original.key);
    if (!row) continue;
    try {
      const tail = row.url.split(`/projects/${row.projectId}/`)[1]!;
      const saved = await request<'ProjectResponse'>(`/projects/${row.projectId}/offline-sync`, { method: 'POST', networkOnly: true, idempotencyKey: row.key, body: { method: row.method, tail, body: row.body } });
      const result = object(saved);
      const actualId = result.submissionId ?? result.commentId ?? result.versionId ?? result.materialVersionId ?? result.taskId;
      if (typeof actualId === 'string') await replaceLocalIds(account.id, row.localId, actualId);
      await removeOperation(row.key);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status === 401) throw error;
      let server: unknown;
      if (error.status === 409) {
        try { server = await currentEntity(row); } catch { /* Keep the local copy even if fetching the server version fails. */ }
        if (row.method === 'PATCH' && error.code === 'VERSION_CONFLICT') {
          const merged = mergeUnchangedFields(row.base, server, row.body);
          if (merged) {
            // The earlier request definitively failed. A changed request needs a new idempotency key.
            await putOperation({ ...row, key: crypto.randomUUID(), body: merged, base: server, error: 'safe-merge' });
            await removeOperation(row.key);
            window.dispatchEvent(new Event('offline-sync-retry'));
            blockedProjects.add(row.projectId);
            continue;
          }
        }
      }
      await putOperation({ ...row, state: error.status === 409 ? 'conflict' : 'blocked', error: error.message, server });
      blockedProjects.add(row.projectId);
    }
  }
  // Refresh cached pages after committing, retaining local overlays for anything still pending.
  for (const snapshot of await snapshots(account.id)) {
    if (!navigator.onLine || offlineAccount()?.id !== account.id) break;
    if (snapshot.url.includes('/auth/') || snapshot.url.endsWith('/offline-ready')) continue;
    try { await request<'ProjectResponse'>(snapshot.url, { networkOnly: true }); } catch { /* Each inaccessible page is retried when explicitly opened. */ }
  }
  window.dispatchEvent(new Event('offline-sync-completed'));
}
export async function synchronizeOffline(): Promise<void> {
  if (syncing) return syncing;
  const run = async () => {
    const execute = async () => {
      await performSync();
      if ((await operations()).some(row => row.state === 'pending' && row.error === 'safe-merge')) await performSync();
    };
    if (navigator.locks) await navigator.locks.request('buwei-offline-sync', { ifAvailable: true }, async lock => { if (lock) await execute(); });
    else await execute();
  };
  syncing = run().finally(() => { syncing = undefined; });
  return syncing;
}
export async function resolveOperation(row: PendingOperation, choice: 'server' | 'local'): Promise<void> {
  if (row.accountId !== offlineAccount()?.id) throw new Error('请使用原账户处理这份离线记录');
  if (choice === 'local') {
    if (!navigator.onLine) throw new Error('解决冲突需要联网读取最新版本');
    const current = await currentEntity(row);
    const revision = object(current).revision;
    if (!Number.isInteger(revision) || !['PUT', 'PATCH'].includes(row.method)) throw new Error('此操作需要在原页面重新核对后提交；本机内容已保留');
    await putOperation({ ...row, key: crypto.randomUUID(), state: 'pending', error: undefined, server: undefined, base: current, body: { ...row.body, expectedRevision: revision } });
  }
  await removeOperation(row.key);
  window.dispatchEvent(new Event('offline-sync-completed'));
}
async function performPrepareProject(projectId: string): Promise<void> {
  const base = `/api/v1/projects/${projectId}`;
  const accountId = offlineAccount()?.id;
  const load = (url: string, query?: Record<string, string | number | null>) => {
    if (!accountId || offlineAccount()?.id !== accountId) throw new Error('账户已切换，停止缓存准备');
    return request<'ProjectResponse'>(url, { query, networkOnly: true, requireOfflinePersistence: true });
  };
  const list = async (tail: string, query: Record<string, string | number> = {}) => {
    const all: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const data = object(await load(tail.startsWith('/api/') ? tail : `${base}${tail}`, { ...query, limit: 100, cursor }));
      if (Array.isArray(data.items)) all.push(...data.items as Record<string, unknown>[]);
      cursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error('离线准备遇到重复分页游标');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return all;
  };
  const failures: unknown[] = [];
  const attempt = async <T>(work: () => Promise<T>, optional = false): Promise<T | undefined> => {
    try { return await work(); }
    catch (error) {
      if (!(optional && error instanceof ApiError && error.status === 403)) failures.push(error);
      return undefined;
    }
  };
  const pages: Array<() => Promise<unknown>> = [
    () => load(base), () => load('/capabilities'), () => list('/api/v1/projects'),
    () => load(`${base}/goal`), () => load(`${base}/collaboration/settings`),
    () => list('/members'), () => load(`${base}/members/me`),
    () => list('/resource-library'), () => list('/sources'), () => list('/requirement-sets'),
    () => load(`${base}/collaboration/feedback/current`), () => load(`${base}/collaboration/feedback/history`),
    () => attempt(() => load(`${base}/ai/clarifications`), true),
    () => attempt(() => list('/collaboration/proposals'), true),
    () => load(`${base}/task-inquiries/unread`),
  ];
  // Prioritize tasks; a denied/unavailable supporting endpoint must not block them.
  const tasks = await attempt(() => list('/tasks')) ?? [];
  const materials = await attempt(() => list('/materials')) ?? [];
  for (const task of tasks) {
    const id = String(task.taskId);
    pages.push(() => load(`${base}/tasks/${id}`),
      () => list('/comments', { targetType: 'task', targetId: id }),
      () => load(`${base}/tasks/${id}/submissions`));
  }
  for (const material of materials) {
    const id = String(material.materialId);
    pages.push(() => load(`${base}/materials/${id}`),
      () => list('/materials/' + id + '/versions'),
      () => list('/comments', { targetType: 'material', targetId: id }));
  }
  for (let i = 0; i < pages.length; i += 4) {
    await Promise.all(pages.slice(i, i + 4).map(work => attempt(work)));
  }
  if (failures.length) throw failures[0];
  if (offlineAccount()?.id !== accountId) return;
  await writeSnapshot(`${base}/offline-ready`, { preparedAt: new Date().toISOString() }, accountId);
  window.dispatchEvent(new Event('offline-data-changed'));
}
export async function preparedAt(projectId: string): Promise<string | null> {
  const marker = await readSnapshot(`/api/v1/projects/${projectId}/offline-ready`);
  return typeof object(marker?.data).preparedAt === 'string' ? object(marker?.data).preparedAt as string : null;
}

const preparations = new Map<string, Promise<void>>();
export function prepareProject(projectId: string): Promise<void> {
  const key = (offlineAccount()?.id ?? '') + ':' + projectId;
  const existing = preparations.get(key);
  if (existing) return existing;
  const pending = performPrepareProject(projectId).finally(() => preparations.delete(key));
  preparations.set(key, pending);
  return pending;
}
