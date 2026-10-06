import type { User } from '../api/types';

export type Snapshot = { key: string; accountId: string; url: string; data: unknown; savedAt: string; etag?: string };
export type PendingOperation = {
  key: string; accountId: string; projectId: string; url: string; method: string;
  body: Record<string, unknown>; localId: string; base: unknown; createdAt: string;
  state: 'pending' | 'conflict' | 'blocked'; error?: string; server?: unknown;
};
const accountKey = 'buwei:offline-account';
let database: Promise<IDBDatabase> | undefined;
const clearingAccounts = new Set<string>();

export function offlineAccount(): User | null {
  try { return JSON.parse(localStorage.getItem(accountKey) ?? 'null') as User | null; }
  catch { return null; }
}
export function rememberAccount(user: User, newSession = false): boolean {
  if (clearingAccounts.has(user.id) && !newSession) return false;
  localStorage.setItem(accountKey, JSON.stringify(user));
  if (newSession) clearingAccounts.delete(user.id);
  return true;
}
export function forgetAccount(): void {
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
    const request = action(transaction.objectStore(name));
    let value: T;
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('离线数据写入失败'));
  });
}
export function normalizeUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}
export async function readSnapshot(url: string, accountId = offlineAccount()?.id): Promise<Snapshot | undefined> {
  if (!accountId) return undefined;
  return transact<Snapshot | undefined>('snapshots', 'readonly', store => store.get(`${accountId}:${normalizeUrl(url)}`));
}
export async function writeSnapshot(url: string, data: unknown, accountId = offlineAccount()?.id, etag?: string): Promise<void> {
  if (!accountId || clearingAccounts.has(accountId)) return;
  const normalized = normalizeUrl(url);
  await transact('snapshots', 'readwrite', store => store.put({ key: `${accountId}:${normalized}`, accountId, url: normalized, data, savedAt: new Date().toISOString(), ...(etag ? { etag } : {}) } satisfies Snapshot));
}
export async function snapshots(accountId = offlineAccount()?.id): Promise<Snapshot[]> {
  return accountId ? transact('snapshots', 'readonly', store => store.index('accountId').getAll(accountId)) : [];
}
/** Reuse a complete cached cursor chain when callers choose a different page size. */
export async function readCachedList(url: string): Promise<unknown | undefined> {
  const wanted = new URL(url, window.location.origin);
  if (wanted.searchParams.has('cursor')) return undefined;
  const filter = (candidate: URL) => {
    for (const key of new Set([...wanted.searchParams.keys(), ...candidate.searchParams.keys()])) {
      if (key !== 'limit' && key !== 'cursor' && wanted.searchParams.get(key) !== candidate.searchParams.get(key)) return false;
    }
    return true;
  };
  const pages = (await snapshots()).filter(row => {
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
  await transact('operations', 'readwrite', store => store.put(operation));
  window.dispatchEvent(new Event('offline-data-changed'));
}
export async function removeOperation(key: string): Promise<void> {
  await transact('operations', 'readwrite', store => store.delete(key));
  window.dispatchEvent(new Event('offline-data-changed'));
}
export async function clearOfflineAccount(accountId: string): Promise<void> {
  clearingAccounts.add(accountId);
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
    if (offlineAccount()?.id === accountId) forgetAccount();
    window.dispatchEvent(new Event('offline-data-changed'));
  } catch (error) { clearingAccounts.delete(accountId); throw error; }
}
