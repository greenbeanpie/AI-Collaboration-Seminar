const prefix = 'buwei:';

function browserStorage(): Storage | null {
  try { return window.localStorage; }
  catch { return null; }
}

export function saveDraft(accountId: string, projectId: string, materialId: string, value: unknown): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.setItem(draftKey(accountId, projectId, materialId), JSON.stringify({ savedAt: new Date().toISOString(), value }));
    return true;
  } catch { return false; }
}

export function getDraft<T>(accountId: string, projectId: string, materialId: string): { savedAt: string; value: T } | null {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftKey(accountId, projectId, materialId));
    return raw ? JSON.parse(raw) as { savedAt: string; value: T } : null;
  } catch { return null; }
}

export function removeDraft(accountId: string, projectId: string, materialId: string): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.removeItem(draftKey(accountId, projectId, materialId));
    return true;
  } catch { return false; }
}

export function saveRecentSession(accountId: string, projectId: string, sessionId: string): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  const key = `${prefix}sessions:${accountId}:${projectId}`;
  try {
    const current = JSON.parse(storage.getItem(key) ?? '[]') as string[];
    storage.setItem(key, JSON.stringify([sessionId, ...current.filter((id) => id !== sessionId)].slice(0, 20)));
    return true;
  } catch { return false; }
}

export function getRecentSessions(accountId: string, projectId: string): string[] {
  const storage = browserStorage();
  if (!storage) return [];
  try { return JSON.parse(storage.getItem(`${prefix}sessions:${accountId}:${projectId}`) ?? '[]') as string[]; }
  catch { return []; }
}

export function clearAccountStorage(accountId: string): void {
  const storage = browserStorage();
  if (!storage) return;
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(`${prefix}draft:${accountId}:`) || key?.startsWith(`${prefix}sessions:${accountId}:`)) keys.push(key);
    }
  } catch { return; }
  keys.forEach((key) => { try { storage.removeItem(key); } catch { /* Logout must not fail because browser storage is unavailable. */ } });
}

function draftKey(accountId: string, projectId: string, materialId: string) {
  return `${prefix}draft:${accountId}:${projectId}:${materialId}`;
}
