import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearAccountStorage } from '../storage';
import { readCommentDraft, removeCommentDraft, writeCommentDraft } from './comment-draft';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('isolates account, project, target type and target identity and supports account cleanup', () => {
  for (const [account, project, type, target] of [['a', 'p', 'task', 't'], ['b', 'p', 'task', 't'], ['a', 'q', 'task', 't'], ['a', 'p', 'material', 't'], ['a', 'p', 'task', 'u']] as const) {
    writeCommentDraft(account, project, type, target, [account, project, type, target].join('/'));
  }
  expect(readCommentDraft('a', 'p', 'task', 't').draft?.body).toBe('a/p/task/t');
  expect(readCommentDraft('a', 'q', 'task', 't').draft?.body).toBe('a/q/task/t');
  expect(readCommentDraft('a', 'p', 'material', 't').draft?.body).toBe('a/p/material/t');
  expect(readCommentDraft('a', 'p', 'task', 'u').draft?.body).toBe('a/p/task/u');
  clearAccountStorage('a');
  expect(readCommentDraft('a', 'p', 'task', 't').draft).toBeNull();
  expect(readCommentDraft('b', 'p', 'task', 't').draft?.body).toBe('b/p/task/t');
});

it('retains a newer draft from another tab and removes an intentionally empty draft', () => {
  writeCommentDraft('a', 'p', 'task', 't', '新的文字');
  expect(removeCommentDraft('a', 'p', 'task', 't', '已发送的文字')).toBe(true);
  expect(readCommentDraft('a', 'p', 'task', 't').draft?.body).toBe('新的文字');
  expect(writeCommentDraft('a', 'p', 'task', 't', '')).toBe(true);
  expect(readCommentDraft('a', 'p', 'task', 't').draft).toBeNull();
});

it('reports corrupt drafts and storage write or removal failures', () => {
  localStorage.setItem('ai-office:account:a:comment-draft:p:task:t', '{');
  expect(readCommentDraft('a', 'p', 'task', 't')).toEqual({ draft: null, failed: true });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  expect(writeCommentDraft('a', 'p', 'task', 't', '未发送')).toBe(false);
  vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  expect(removeCommentDraft('a', 'p', 'task', 't')).toBe(false);
});
