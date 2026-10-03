import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationWorkspace } from './CollaborationWorkspace';
import type { ProjectClarification } from '../api/clarifications';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-1', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: true } } }) }));
vi.mock('./ProjectSourceContext', () => ({ ProjectSourceContext: () => null }));
vi.mock('./ProjectAiTools', () => ({ ProjectSearchOption: () => null, ProjectToolCalls: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const question: ProjectClarification = { id: 'question-project', jobId: 'existing-job', question: '谁负责审核最终成果？', reason: '决定分工与验收顺序', options: ['项目负责人', '全体成员'], allowUndecided: true, round: 1, maxRounds: 3, status: 'pending', revision: 5, createdAt: '2026-10-03T08:00:00Z' };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(status < 400 ? { data, requestId: 'test' } : { error: { code: 'REVISION_CONFLICT', message: '回答版本已变化', retryable: false }, requestId: 'test' }), { status, headers: { 'Content-Type': 'application/json' } }); }
function setup({ failAnswer = false } = {}) {
  let questions = [question];
  let jobStatus = 'waiting_input';
  let fail = failAnswer;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path.endsWith('/ai/clarifications')) return response({ items: questions });
    if (path.endsWith('/answer')) {
      if (fail) { fail = false; questions = [{ ...question, revision: 6 }]; return response(null, 409); }
      questions = []; jobStatus = 'succeeded'; return response({ jobId: question.jobId, status: 'queued' });
    }
    if (path.endsWith('/cancel')) { questions = []; jobStatus = 'cancelled'; return response({ jobId: question.jobId, status: 'cancelled' }); }
    if (path === '/api/v1/jobs/existing-job') return response({ jobId: question.jobId, status: jobStatus, result: jobStatus === 'waiting_input' ? { clarification: question } : {} });
    if (init?.method && init.method !== 'GET') throw new Error(`Unexpected mutation: ${path}`);
    if (path.endsWith('/goal')) return response({ title: '项目目标', detail: '', revision: 1, graphRevision: 1 });
    return response({ items: [], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['project-goal', 'project-1'], { title: '项目目标', detail: '', revision: 1, graphRevision: 1 });
  client.setQueryData(['collaboration-tasks', 'project-1'], { items: [] });
  client.setQueryData(['collaboration-settings', 'project-1'], { aiCollaborationEnabled: true, assignmentMode: 'automatic', evaluationMode: 'manual', revision: 1 });
  client.setQueryData(['collaboration-proposals', 'project-1'], { items: [] });
  client.setQueryData(['members', 'project-1'], []);
  client.setQueryData(['member-me', 'project-1'], { userId: 'owner' });
  const mount = () => render(<QueryClientProvider client={client}><MemoryRouter><CollaborationWorkspace /></MemoryRouter></QueryClientProvider>);
  return { fetch, mount, client };
}
async function openQuestion() {
  fireEvent.click(await screen.findByRole('button', { name: '回答 AI 的问题（1）' }));
  await screen.findByText(question.question);
}
describe('persisted project clarification', () => {
  it('recovers on reload, preserves input across dialog dismissal, and resumes the same job', async () => {
    const { fetch, mount } = setup(); const first = mount();
    await openQuestion();
    first.unmount(); mount(); await openQuestion();
    fireEvent.change(screen.getByLabelText('持续项目反馈'), { target: { value: '新的请求' } });
    expect(screen.getByRole('button', { name: '生成拆解建议' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('补充回答'), { target: { value: '由项目负责人审核' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await openQuestion();
    expect(screen.getByLabelText('补充回答')).toHaveValue('由项目负责人审核');
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await screen.findByText('AI 任务：已完成');
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe('/api/v1/projects/project-1/ai/clarifications/question-project/answer');
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ expectedRevision: 5, text: '由项目负责人审核' });
    expect(fetch.mock.calls.some(([path]) => path === '/api/v1/jobs/existing-job')).toBe(true);
    expect(screen.queryByText(question.question)).not.toBeInTheDocument();
  });
  it('refreshes a stale revision, keeps the answer and submits the refreshed revision on retry', async () => {
    const { fetch, mount } = setup({ failAnswer: true }); mount(); await openQuestion();
    fireEvent.click(screen.getByRole('radio', { name: '全体成员' }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await screen.findByText(/问题状态已更新，已重新读取/);
    await waitFor(() => expect(screen.getByRole('button', { name: '提交回答并继续' })).toBeEnabled());
    expect(screen.getByRole('radio', { name: '全体成员' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await screen.findByText('AI 任务：已完成');
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes.map(([, init]) => JSON.parse(String(init?.body)).expectedRevision)).toEqual([5, 6]);
  });
  it.each(['undecided', 'cancel'])('handles %s explicitly without creating or applying project tasks', async action => {
    const { fetch, mount } = setup(); mount(); await openQuestion();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: action === 'undecided' ? '尚未决定，先保留未决范围' : '取消本次 AI 操作' })));
    await waitFor(() => expect(screen.queryByText(question.question)).not.toBeInTheDocument());
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[0])).toMatch(new RegExp(`/clarifications/question-project/${action === 'cancel' ? 'cancel' : 'answer'}$`));
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual(action === 'cancel' ? { expectedRevision: 5 } : { expectedRevision: 5, undecided: true });
  });
});
