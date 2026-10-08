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

export function clearAccountStorage(accountId: string, strict = false): void {
  const storage = browserStorage();
  if (!storage) { if (strict) throw new Error('无法清除本机草稿，请检查存储权限后重试'); return; }
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(`${prefix}draft:${accountId}:`) || key?.startsWith(`${prefix}sessions:${accountId}:`) || key === 'buwei:ai-reference-badges:' + accountId || key === 'app-push-introduction:' + accountId || key?.startsWith('agent-bridge-device:' + accountId + ':') || key?.startsWith('ai-office:account:' + accountId + ':')) keys.push(key);
    }
  } catch (error) { if (strict) throw error; return; }
  keys.forEach((key) => { try { storage.removeItem(key); } catch (error) { if (strict) throw error; } });
  if (strict) {
    const sessionKeys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('ai-office:account:' + accountId + ':') || key?.startsWith('ai-office:source-jobs:' + accountId + ':') || key?.startsWith('ai-office:source-files:' + accountId + ':') || key?.startsWith('ai-office:assessment-draft:' + accountId + ':') || key === 'ai-office:creation-wizard:' + encodeURIComponent(accountId) || key === 'ai-office:v1:' + encodeURIComponent(accountId) + ':project-creation') sessionKeys.push(key);
    }
    for (const key of sessionKeys) sessionStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('account-device-cleared', { detail: { accountId } }));
  }
}

function draftKey(accountId: string, projectId: string, materialId: string) {
  return `${prefix}draft:${accountId}:${projectId}:${materialId}`;
}
