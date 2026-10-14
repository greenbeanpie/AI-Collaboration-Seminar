import type { User } from '../api/types';
import { setDesktopAccount } from '../desktop/lifecycle';
import { storageFailureMessage } from './storage-protection';

export type Snapshot = { key: string; accountId: string; url: string; data: unknown; savedAt: string; etag?: string };
export type PendingOperation = {
  key: string; accountId: string; projectId: string; url: string; method: string;
  body: Record<string, unknown>; localId: string; base: unknown; createdAt: string;
  state: 'pending' | 'conflict' | 'blocked'; error?: string; server?: unknown;
  blockedReason?: 'project-access-revoked';
  desktopAttachmentsResolved?: boolean;
};
const accountKey = 'buwei:offline-account';
let database: Promise<IDBDatabase> | undefined;
const clearingAccounts = new Set<string>();
const storageEpochs = new Map<string, number>();
const accessPrefix = 'buwei:project-access:';
const accessFallback = new Map<string, { epoch: number; revoked: boolean }>();
export function projectIdForUrl(url: string): string | undefined { return new URL(url, window.location.origin).pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/|$)/)?.[1]; }
function projectAccess(accountId: string, projectId: string): { epoch: number; revoked: boolean } {
  const key = `${accessPrefix}${accountId}:${projectId}`, memory = accessFallback.get(key);
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{"epoch":0,"revoked":false}') as { epoch?: unknown; revoked?: unknown };
    if (!value || typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.revoked !== 'boolean') return memory ?? { epoch: 0, revoked: true };
    if (memory && memory.epoch > value.epoch) return memory;
    return { epoch: value.epoch, revoked: value.revoked };
  }
  catch { return memory ?? { epoch: 0, revoked: true }; }
}
export const projectEpoch = (accountId: string, projectId: string): number => projectAccess(accountId, projectId).epoch;
export const projectRevoked = (accountId: string, projectId: string): boolean => projectAccess(accountId, projectId).revoked;
function filterRevokedProjects(url: string, data: unknown, accountId: string): unknown {
  if (new URL(url, window.location.origin).pathname !== '/api/v1/projects' || !data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) return data;
  return { ...data, items: data.items.filter(item => !item || typeof item !== 'object' || !projectRevoked(accountId, String(item.id ?? item.projectId ?? ''))) };
}
export function restoreProjectAccess(accountId: string, projectId: string): void {
  const previous = projectAccess(accountId, projectId);
  setProjectAccess(accountId, projectId, { ...previous, revoked: false });
}
function setProjectAccess(accountId: string, projectId: string, value: { epoch: number; revoked: boolean }): void {
  const key = `${accessPrefix}${accountId}:${projectId}`;
  accessFallback.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (error) { window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: storageFailureMessage(error) } })); }
}

/** Hide revoked data immediately; preserve drafts and block durable intents without deleting them. */
export async function revokeProjectAccess(accountId: string, projectId: string): Promise<void> {
  const previous = projectAccess(accountId, projectId);
  setProjectAccess(accountId, projectId, { epoch: previous.epoch + 1, revoked: true });
  window.dispatchEvent(new CustomEvent('project-access-revoked', { detail: { accountId, projectId } }));
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['snapshots', 'operations'], 'readwrite');
    for (const name of ['snapshots', 'operations']) {
      const store = tx.objectStore(name);
      const cursorRequest = store.index('accountId').openCursor(IDBKeyRange.only(accountId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (name === 'snapshots') {
          const row = cursor.value as Snapshot;
          if (projectIdForUrl(row.url) === projectId) cursor.delete();
          else cursor.update({ ...row, data: filterRevokedProjects(row.url, row.data, accountId) });
        } else {
          const row = cursor.value as PendingOperation;
          if (row.projectId === projectId) cursor.update({ ...row, state: 'blocked', blockedReason: 'project-access-revoked', error: '项目权限已变更，本机修改保留；不会自动重新提交。' });
        }
        cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('项目快照清理失败；内容已隔离，请重试清理。'));
  });
  window.dispatchEvent(new Event('offline-data-changed'));
}

export function offlineAccount(): User | null {
  try { return JSON.parse(localStorage.getItem(accountKey) ?? 'null') as User | null; }
  catch { return null; }
}
export function rememberAccount(user: User, newSession = false): boolean {
  if (clearingAccounts.has(user.id) && !newSession) return false;
  localStorage.setItem(accountKey, JSON.stringify(user));
  if (newSession) clearingAccounts.delete(user.id);
  setDesktopAccount(user.id);
  return true;
}
export function forgetAccount(): void {
  setDesktopAccount(null);
  try { localStorage.removeItem(accountKey); } catch { /* Clearing the in-memory session still proceeds. */ }
}
function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('浏览器无法保存离线数据')); return; }
    const request = indexedDB.open('buwei-offline-v1', 1);
    request.onupgradeneeded = () => {
      for (const name of ['snapshots', 'operations']) {
        const store = request.result.createObjectStore(name, { keyPath: 'key' });
        store.createIndex('accountId', 'accountId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('离线存储打开失败'));
    request.onblocked = () => reject(new Error('离线存储被其他窗口占用'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}
export async function transact<T>(name: 'snapshots' | 'operations', mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    let request: IDBRequest<T>;
    try { request = action(transaction.objectStore(name)); }
    catch (failure) {
      transaction.abort();
      if (mode === 'readwrite' && failure instanceof DOMException) window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: storageFailureMessage(failure) } }));
      reject(failure); return;
    }
    let value: T;
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = transaction.onerror = () => {
      const failure = transaction.error ?? request.error ?? new Error('离线数据写入失败');
      if (mode === 'readwrite') window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: storageFailureMessage(failure) } }));
      reject(failure);
    };
  });
}
export function normalizeUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}
export async function readSnapshot(url: string, accountId = offlineAccount()?.id): Promise<Snapshot | undefined> {
  if (!accountId) return undefined;
  const projectId = projectIdForUrl(url);
  if (projectId && projectRevoked(accountId, projectId)) return undefined;
  const row = await transact<Snapshot | undefined>('snapshots', 'readonly', store => store.get(`${accountId}:${normalizeUrl(url)}`));
  if (projectId && projectRevoked(accountId, projectId)) return undefined;
  return row ? { ...row, data: filterRevokedProjects(url, row.data, accountId) } : undefined;
}
export async function writeSnapshot(url: string, data: unknown, accountId = offlineAccount()?.id, etag?: string): Promise<void> {
  if (!accountId || clearingAccounts.has(accountId)) return;
  const epoch = storageEpochs.get(accountId) ?? 0;
  const projectId = projectIdForUrl(url), fence = projectId ? projectEpoch(accountId, projectId) : 0;
  const normalized = normalizeUrl(url);
  await transact('snapshots', 'readwrite', store => {
    if (clearingAccounts.has(accountId) || (storageEpochs.get(accountId) ?? 0) !== epoch) throw new Error('此账号的本机数据已清除，已停止旧缓存写入');
    if (projectId && (projectRevoked(accountId, projectId) || projectEpoch(accountId, projectId) !== fence)) throw new Error('项目权限已变化，已停止旧缓存写入');
    return store.put({ key: `${accountId}:${normalized}`, accountId, url: normalized, data: filterRevokedProjects(url, data, accountId), savedAt: new Date().toISOString(), ...(etag ? { etag } : {}) } satisfies Snapshot);
  });
}
export async function snapshots(accountId = offlineAccount()?.id): Promise<Snapshot[]> {
  if (!accountId) return [];
  const rows = await transact<Snapshot[]>('snapshots', 'readonly', store => store.index('accountId').getAll(accountId));
  return rows.filter(row => { const projectId = projectIdForUrl(row.url); return !projectId || !projectRevoked(accountId, projectId); }).map(row => ({ ...row, data: filterRevokedProjects(row.url, row.data, accountId) }));
}
/** Reuse a complete cached cursor chain when callers choose a different page size. */
export async function readCachedList(url: string, accountId = offlineAccount()?.id): Promise<unknown | undefined> {
  const wanted = new URL(url, window.location.origin);
  if (wanted.searchParams.has('cursor')) return undefined;
  const filter = (candidate: URL) => {
    for (const key of new Set([...wanted.searchParams.keys(), ...candidate.searchParams.keys()])) {
      if (key !== 'limit' && key !== 'cursor' && wanted.searchParams.get(key) !== candidate.searchParams.get(key)) return false;
    }
    return true;
  };
  const pages = (await snapshots(accountId)).filter(row => {
    const candidate = new URL(row.url, window.location.origin);
    return candidate.pathname === wanted.pathname && filter(candidate) && Array.isArray((row.data as { items?: unknown[] })?.items);
  });
  const first = pages.filter(row => !new URL(row.url, window.location.origin).searchParams.has('cursor')).sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
  if (!first) return undefined;
  const pageSize = new URL(first.url, window.location.origin).searchParams.get('limit');
  let page = first;
  const all: unknown[] = [], seen = new Set<string>();
  for (;;) {
    const data = page.data as { items: unknown[]; nextCursor?: string | null };
    all.push(...data.items);
    if (!data.nextCursor) return { ...data, items: all, nextCursor: null };
    if (seen.has(data.nextCursor)) return undefined;
    seen.add(data.nextCursor);
    const next = pages.find(row => {
      const query = new URL(row.url, window.location.origin).searchParams;
      return query.get('cursor') === data.nextCursor && query.get('limit') === pageSize;
    });
    if (!next) return undefined;
    page = next;
  }
}
export async function operations(accountId = offlineAccount()?.id): Promise<PendingOperation[]> {
  if (!accountId) return [];
  const rows = await transact<PendingOperation[]>('operations', 'readonly', store => store.index('accountId').getAll(accountId));
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}
export async function putOperation(operation: PendingOperation): Promise<void> {
  if (clearingAccounts.has(operation.accountId)) throw new Error('此账号的本机数据已清除，请重新登录后操作');
  const epoch = storageEpochs.get(operation.accountId) ?? 0;
  const fence = projectEpoch(operation.accountId, operation.projectId);
  await transact('operations', 'readwrite', store => {
    if (clearingAccounts.has(operation.accountId) || (storageEpochs.get(operation.accountId) ?? 0) !== epoch) throw new Error('此账号的本机数据已清除，已停止旧操作写入');
    const revoked = projectRevoked(operation.accountId, operation.projectId) || projectEpoch(operation.accountId, operation.projectId) !== fence;
    return store.put(revoked ? { ...operation, state: 'blocked', blockedReason: 'project-access-revoked', error: '项目权限已变更，本机修改保留；不会自动重新提交。' } : operation);
  });
  window.dispatchEvent(new Event('offline-data-changed'));
}
export async function removeOperation(key: string): Promise<void> {
  await transact('operations', 'readwrite', store => store.delete(key));
  window.dispatchEvent(new Event('offline-data-changed'));
}
export async function clearOfflineAccount(accountId: string): Promise<void> {
  clearingAccounts.add(accountId);
  storageEpochs.set(accountId, (storageEpochs.get(accountId) ?? 0) + 1);
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['snapshots', 'operations'], 'readwrite');
      for (const name of ['snapshots', 'operations']) {
        const request = tx.objectStore(name).index('accountId').openKeyCursor(IDBKeyRange.only(accountId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { tx.objectStore(name).delete(cursor.primaryKey); cursor.continue(); }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('清除本机数据失败，请重试'));
    });
    const markerKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(`${accessPrefix}${accountId}:`)) markerKeys.push(key); }
    markerKeys.forEach(key => localStorage.removeItem(key));
    for (const key of accessFallback.keys()) if (key.startsWith(`${accessPrefix}${accountId}:`)) accessFallback.delete(key);
    if (offlineAccount()?.id === accountId) forgetAccount();
    window.dispatchEvent(new Event('offline-data-changed'));
  } catch (error) { clearingAccounts.delete(accountId); throw error; }
}
