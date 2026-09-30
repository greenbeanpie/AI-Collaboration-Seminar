const prefix = 'buwei:';

export function saveDraft(accountId: string, projectId: string, materialId: string, value: unknown) {
  try { window.localStorage.setItem(draftKey(accountId, projectId, materialId), JSON.stringify({ savedAt: new Date().toISOString(), value })); }
  catch { /* Quota or privacy mode: the editor still keeps the in-memory draft. */ }
}

export function getDraft<T>(accountId: string, projectId: string, materialId: string): { savedAt: string; value: T } | null {
  try {
    const raw = window.localStorage.getItem(draftKey(accountId, projectId, materialId));
    return raw ? JSON.parse(raw) as { savedAt: string; value: T } : null;
  } catch { return null; }
}

export function removeDraft(accountId: string, projectId: string, materialId: string) {
  window.localStorage.removeItem(draftKey(accountId, projectId, materialId));
}

export function saveRecentSession(accountId: string, projectId: string, sessionId: string) {
  const key = `${prefix}sessions:${accountId}:${projectId}`;
  try {
    const current = JSON.parse(window.localStorage.getItem(key) ?? '[]') as string[];
    window.localStorage.setItem(key, JSON.stringify([sessionId, ...current.filter((id) => id !== sessionId)].slice(0, 20)));
  } catch { window.localStorage.setItem(key, JSON.stringify([sessionId])); }
}

export function getRecentSessions(accountId: string, projectId: string): string[] {
  try { return JSON.parse(window.localStorage.getItem(`${prefix}sessions:${accountId}:${projectId}`) ?? '[]') as string[]; }
  catch { return []; }
}

export function clearAccountStorage(accountId: string) {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(`${prefix}draft:${accountId}:`) || key?.startsWith(`${prefix}sessions:${accountId}:`)) keys.push(key);
  }
  keys.forEach((key) => window.localStorage.removeItem(key));
}

function draftKey(accountId: string, projectId: string, materialId: string) {
  return `${prefix}draft:${accountId}:${projectId}:${materialId}`;
}
