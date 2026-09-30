import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAccountStorage, getDraft, getRecentSessions, removeDraft, saveDraft, saveRecentSession } from './storage';

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('account-scoped local recovery data', () => {
  it('isolates offline drafts and clears only the logging-out account', () => {
    saveDraft('account-a', 'project-1', 'material-1', { text: 'A 的未保存材料' });
    saveDraft('account-b', 'project-1', 'material-1', { text: 'B 的未保存材料' });

    clearAccountStorage('account-a');

    expect(getDraft('account-a', 'project-1', 'material-1')).toBeNull();
    expect(getDraft<{ text: string }>('account-b', 'project-1', 'material-1')?.value.text).toBe('B 的未保存材料');
  });

  it('deduplicates recent real session IDs and removes them on logout', () => {
    saveRecentSession('account-a', 'project-1', 'session-1');
    saveRecentSession('account-a', 'project-1', 'session-2');
    saveRecentSession('account-a', 'project-1', 'session-1');
    expect(getRecentSessions('account-a', 'project-1')).toEqual(['session-1', 'session-2']);

    clearAccountStorage('account-a');
    expect(getRecentSessions('account-a', 'project-1')).toEqual([]);
  });

  it('reports a quota failure without throwing and keeps logout cleanup best-effort', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); });
    expect(saveDraft('account-a', 'project-1', 'material-1', { text: '尚未保存' })).toBe(false);
    expect(saveRecentSession('account-a', 'project-1', 'session-1')).toBe(false);

    vi.restoreAllMocks();
    saveDraft('account-a', 'project-1', 'material-1', { text: '服务端已保存' });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('Storage is disabled', 'SecurityError'); });
    expect(() => clearAccountStorage('account-a')).not.toThrow();
    expect(() => removeDraft('account-a', 'project-1', 'material-1')).not.toThrow();
  });
});
