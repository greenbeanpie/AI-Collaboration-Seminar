import { afterEach, expect, it, vi } from 'vitest';
import { clarificationApi, clarificationFromJob, type AiClarification } from './clarifications';
const question: AiClarification = { id: 'q/1', question: '何时交付？', options: [], allowUndecided: true, round: 1, maxRounds: 3, status: 'pending', revision: 7, createdAt: '2026-10-03' };
afterEach(() => vi.unstubAllGlobals());
it('encodes identifiers, sends question revision and disables caching for pending project questions', async () => {
  const fetch = vi.fn().mockImplementation(() => new Response(JSON.stringify({ data: { items: [] }, requestId: 'test' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await clarificationApi.list('p/1');
  await clarificationApi.answerProject('p/1', question, { text: '周五' });
  await clarificationApi.cancelDraft('draft/1', question);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/projects/p%2F1/ai/clarifications');
  expect(fetch.mock.calls[0]?.[1]?.cache).toBe('no-store');
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/projects/p%2F1/ai/clarifications/q%2F1/answer');
  expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body)).toEqual({ expectedRevision: 7, text: '周五' });
  expect(fetch.mock.calls[2]?.[0]).toBe('/api/v1/creation-drafts/draft%2F1/clarifications/q%2F1/cancel');
});
it('accepts only complete pending questions from untyped job output', () => {
  expect(clarificationFromJob({ clarification: question }, 'job')).toEqual({ ...question, jobId: 'job' });
  expect(clarificationFromJob({ clarification: { id: 'x', question: 'incomplete' } }, 'job')).toBeNull();
  expect(clarificationFromJob({ clarification: { ...question, status: 'answered' } }, 'job')).toBeNull();
});
