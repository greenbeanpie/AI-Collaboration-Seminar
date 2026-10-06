import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock('../../offline/store', () => ({ offlineAccount: () => state.id ? { id: state.id } : undefined }));
import { accountStorageKey } from './account-storage-key';
it('separates account workflow drafts and never falls back to a legacy unscoped key', () => {
  state.id = 'account-a';
  const first = accountStorageKey('pending-agent-job:project');
  state.id = 'account-b';
  const second = accountStorageKey('pending-agent-job:project');
  expect(first).toBe('ai-office:account:account-a:pending-agent-job:project');
  expect(second).toBe('ai-office:account:account-b:pending-agent-job:project');
  expect(first).not.toBe(second);
  state.id = undefined;
  expect(accountStorageKey('pending-agent-job:project')).not.toBe(first);
  expect(accountStorageKey('pending-agent-job:project')).not.toBe(second);
});
