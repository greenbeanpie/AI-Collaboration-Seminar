import { beforeEach, describe, expect, it } from 'vitest';
import { clearAccountStorage, getDraft, getRecentSessions, saveDraft, saveRecentSession } from './storage';

beforeEach(() => window.localStorage.clear());

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
});
