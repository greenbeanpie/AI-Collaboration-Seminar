import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import { TaskAssistancePlan, type AssistancePlan } from './TaskAiAssistance';
const request = vi.hoisted(() => vi.fn());
const actor = vi.hoisted(() => ({ id: 'u1' }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: actor.id } }) }));
vi.mock('../api/simplification', () => ({ projectRequest: request }));
vi.mock('./TaskAgentHandoff', () => ({ TaskAgentHandoff: () => <div>delegation</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); actor.id = 'u1'; });
const task = { taskId: 't1', revision: 3 } as CollaborationTask;
const result = (changes: Partial<AssistancePlan> = {}): AssistancePlan => ({ status: 'missing', taskRevision: 3, sourceHash: 'current', plan: null, jobId: null, error: null, ...changes });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = <QueryClientProvider client={client}><TaskAssistancePlan projectId="p1" task={task} /></QueryClientProvider>;
  return { ...render(content), content, client };
}
it('reads only until deliberate generation, then disables duplicate generation', async () => {
  request.mockResolvedValue(result()); setup();
  const button = await screen.findByRole('button', { name: '生成辅助计划' });
  expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
  request.mockResolvedValue(result({ status: 'queued', jobId: 'j1' }));
  fireEvent.click(button);
  await waitFor(() => expect(request.mock.calls.filter(call => call[2]?.method === 'POST')).toHaveLength(1));
  expect(request.mock.calls.find(call => call[2]?.method === 'POST')?.[2].body).toEqual({ expectedRevision: 3 });
  await waitFor(() => expect(button).toBeDisabled());
});
it('retains stale saved plan after failed regeneration and reads it on reopening', async () => {
  const saved = result({ status: 'ready', plan: { markdown: '步骤一：采访，人工完成', generatedAt: '2026-10-04T00:00:00Z', sourceHash: 'old', stale: true } });
  request.mockImplementation((_id, _path, options) => options?.method === 'POST' ? Promise.reject(new Error('生成暂不可用')) : Promise.resolve(saved));
  const view = setup(); await screen.findByText('步骤一：采访，人工完成');
  expect(screen.getByText(/当前计划需要更新/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重新生成辅助计划' }));
  await screen.findByText('生成暂不可用'); expect(screen.getByText('步骤一：采访，人工完成')).toBeInTheDocument();
  expect(request.mock.calls.find(call => call[2]?.method === 'POST')?.[2].body).toEqual({ expectedRevision: 3, regenerate: true });
  view.unmount(); render(view.content); await screen.findByText('步骤一：采访，人工完成');
  expect(request.mock.calls.filter(call => call[2]?.method === 'POST')).toHaveLength(1);
});
it('keeps saved plans readable with AI disabled', async () => {
  request.mockResolvedValue(result({ status: 'disabled', plan: { markdown: '原计划', generatedAt: '2026-10-04', sourceHash: 'current', stale: false } }));
  setup(); await screen.findByText('原计划');
  expect(screen.getByRole('button', { name: '重新生成辅助计划' })).toBeDisabled();
  expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
});
it('stores a late generation result only in the original account cache', async () => {
  let finish!: (value: AssistancePlan) => void;
  request.mockImplementation((_id, _path, options) => options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(result()));
  const view = setup(); fireEvent.click(await screen.findByRole('button', { name: '生成辅助计划' }));
  await waitFor(() => expect(finish).toBeDefined());
  actor.id = 'u2';
  view.rerender(<QueryClientProvider client={view.client}><TaskAssistancePlan projectId="p1" task={task} /></QueryClientProvider>);
  finish(result({ status: 'ready', plan: { markdown: '账号一计划', generatedAt: '2026-10-04', sourceHash: 'current', stale: false } }));
  await waitFor(() => expect(view.client.getQueryData<AssistancePlan>(['task-assistance-plan', 'p1', 't1', 3, 'u1'])?.plan?.markdown).toBe('账号一计划'));
  expect(screen.queryByText('账号一计划')).toBeNull();
  expect(view.client.getQueryData<AssistancePlan>(['task-assistance-plan', 'p1', 't1', 3, 'u2'])?.plan).toBeNull();
});

it('offers resume without a second generation action for a failed plan with a job pointer', async () => {
  request.mockResolvedValue(result({ status: 'failed', jobId: 'failed-plan', error: '保存计划未完成' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { jobId: 'failed-plan', status: 'failed', activity: {code:'failed',updatedAt:null,lastResponseAt:null,progress:null,canResume:true,resumeReason:null,uncertain:false} } })));
  setup();
  expect(await screen.findByRole('button',{name:'从停止处继续'})).toBeEnabled();
  expect(screen.queryByRole('button',{name:'生成辅助计划'})).toBeNull();
  expect(screen.queryByRole('button',{name:'重新生成辅助计划'})).toBeNull();
  expect(request.mock.calls.some(call => call[2]?.method === 'POST')).toBe(false);
});
