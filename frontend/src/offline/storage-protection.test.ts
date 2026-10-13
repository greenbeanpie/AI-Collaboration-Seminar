import { afterEach, expect, it, vi } from 'vitest';
import { inspectStorageProtection, requestStorageProtection, storageFailureMessage, storageProtectionMessage } from './storage-protection';
afterEach(() => vi.unstubAllGlobals());
it('inspects protection and quota quietly and requests only on an explicit action', async () => {
  const persist = vi.fn(async () => false);
  vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist, estimate: async () => ({ usage: 12, quota: 100 }) } });
  expect(await inspectStorageProtection()).toEqual({ state: 'best-effort', usage: 12, quota: 100 });
  expect(persist).not.toHaveBeenCalled();
  const result = await requestStorageProtection(); expect(persist).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ state: 'best-effort', requested: true });
  expect(storageProtectionMessage(result)).toContain('未授予存储保护');
});
it('reports unsupported and unavailable checks honestly, without preventing local saving', async () => {
  vi.stubGlobal('navigator', {}); expect(await requestStorageProtection()).toEqual({ state: 'unsupported' });
  vi.stubGlobal('navigator', { storage: { persisted: async () => { throw new Error('blocked'); } } });
  expect(await inspectStorageProtection()).toEqual({ state: 'unavailable' });
});
it('retains granted persistence and avoids unnecessary repeated permission requests', async () => {
  const persist = vi.fn(); vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } });
  expect(await requestStorageProtection()).toMatchObject({ state: 'persistent' }); expect(persist).not.toHaveBeenCalled();
  expect(storageProtectionMessage({ state: 'persistent' })).toContain('清除网站数据仍会删除');
});
it('distinguishes actual storage quota failures and does not claim old local data was deleted', () => {
  expect(storageFailureMessage(new DOMException('quota', 'QuotaExceededError'))).toContain('本机存储空间不足');
  expect(storageFailureMessage(new DOMException('quota', 'QuotaExceededError'))).toContain('待同步操作仍保留');
  expect(storageFailureMessage(new Error('blocked'))).toContain('存储权限');
});
