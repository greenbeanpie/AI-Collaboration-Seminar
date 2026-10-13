export type StorageProtection = {
  state: 'persistent' | 'best-effort' | 'unsupported' | 'unavailable';
  usage?: number;
  quota?: number;
  requested?: boolean;
};

/** Inspect quietly; persistence permission is requested only by an explicit save/download action. */
export async function inspectStorageProtection(): Promise<StorageProtection> {
  const storage = navigator.storage;
  if (!storage?.persisted) return { state: 'unsupported' };
  try {
    const persistent = await storage.persisted();
    let estimate: StorageEstimate = {};
    try { estimate = await storage.estimate?.() ?? {}; } catch { /* Protection status remains useful without an estimate. */ }
    return { state: persistent ? 'persistent' : 'best-effort', usage: estimate.usage, quota: estimate.quota };
  } catch { return { state: 'unavailable' }; }
}

export async function requestStorageProtection(): Promise<StorageProtection> {
  const current = await inspectStorageProtection();
  if (current.state === 'persistent' || !navigator.storage?.persist) return current;
  try {
    const persistent = await navigator.storage.persist();
    const status = await inspectStorageProtection();
    const result: StorageProtection = { ...status, state: persistent ? 'persistent' : 'best-effort', requested: true };
    window.dispatchEvent(new CustomEvent('offline-storage-protection', { detail: result }));
    return result;
  } catch {
    const result: StorageProtection = { ...current, state: 'unavailable', requested: true };
    window.dispatchEvent(new CustomEvent('offline-storage-protection', { detail: result }));
    return result;
  }
}

export function storageFailureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '本机存储空间不足，无法保存这份离线内容。请腾出设备空间后重试；已保存的草稿和待同步操作仍保留。';
  }
  return '本机缓存写入失败，请检查浏览器存储权限或设备空间；当前内容尚不能保证离线可用。';
}

export function storageProtectionMessage(status: StorageProtection): string {
  if (status.state === 'persistent') return '本机存储保护已启用；清除网站数据仍会删除本机内容。';
  if (status.state === 'unsupported') return '此浏览器不支持存储保护检查；本机内容可能被系统回收，请及时联网同步或导出。';
  if (status.state === 'unavailable') return '无法确认本机存储保护；请及时联网同步或导出草稿。';
  return status.requested
    ? '浏览器未授予存储保护；本机内容可能被系统回收，请及时联网同步或导出。'
    : '本机内容可能被系统回收；保存项目时可申请存储保护，请及时联网同步或导出。';
}
