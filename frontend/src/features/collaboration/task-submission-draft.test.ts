import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAccountStorage } from '../../storage';
import { readTaskSubmissionDraft, removeTaskSubmissionDraft, writeTaskSubmissionDraft } from './task-submission-draft';

const draft = { body: '逐条完成标准，稍后提交', baseRevision: 3, conflict: false };
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('task submission recovery storage', () => {
  it('isolates accounts, projects and tasks and participates in account device cleanup', () => {
    for (const [account, project, task] of [['a', 'p', 't'], ['b', 'p', 't'], ['a', 'q', 't'], ['a', 'p', 'u']]) {
      expect(writeTaskSubmissionDraft(account, project, task, { ...draft, body: [account, project, task].join('/') })).toBe(true);
    }
    expect(readTaskSubmissionDraft('a', 'p', 't').draft?.body).toBe('a/p/t');
    expect(readTaskSubmissionDraft('a', 'q', 't').draft?.body).toBe('a/q/t');
    expect(readTaskSubmissionDraft('a', 'p', 'u').draft?.body).toBe('a/p/u');
    clearAccountStorage('a', true);
    expect(readTaskSubmissionDraft('a', 'p', 't').draft).toBeNull();
    expect(readTaskSubmissionDraft('a', 'q', 't').draft).toBeNull();
    expect(readTaskSubmissionDraft('a', 'p', 'u').draft).toBeNull();
    expect(readTaskSubmissionDraft('b', 'p', 't').draft?.body).toBe('b/p/t');
  });

  it('retains a conflict even with empty text and removes an intentionally empty unlocked draft', () => {
    writeTaskSubmissionDraft('a', 'p', 't', { ...draft, body: '', conflict: true });
    expect(readTaskSubmissionDraft('a', 'p', 't').draft).toMatchObject({ body: '', baseRevision: 3, conflict: true });
    writeTaskSubmissionDraft('a', 'p', 't', { ...draft, body: '' });
    expect(readTaskSubmissionDraft('a', 'p', 't').draft).toBeNull();
  });

  it('keeps another tab’s newer edit when an older submission succeeds', () => {
    writeTaskSubmissionDraft('a', 'p', 't', { ...draft, body: '另一标签的新文字' });
    expect(removeTaskSubmissionDraft('a', 'p', 't', draft)).toBe(true);
    expect(readTaskSubmissionDraft('a', 'p', 't').draft?.body).toBe('另一标签的新文字');
  });

  it('reports unreadable, invalid and unwritable local storage', () => {
    localStorage.setItem('ai-office:account:a:task-submission:p:t', '{');
    expect(readTaskSubmissionDraft('a', 'p', 't')).toEqual({ draft: null, failed: true });
    localStorage.setItem('ai-office:account:a:task-submission:p:t', JSON.stringify({ ...draft, version: 1, baseRevision: -1, savedAt: new Date().toISOString() }));
    expect(readTaskSubmissionDraft('a', 'p', 't').failed).toBe(true);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    expect(writeTaskSubmissionDraft('a', 'p', 't', draft)).toBe(false);
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    expect(removeTaskSubmissionDraft('a', 'p', 't')).toBe(false);
  });
});
