import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeApi, type BridgeHandoff } from '../api/agent-bridges';
import type { CollaborationTask } from '../api/collaboration';
import { TaskAgentAction } from './TaskAgentAction';
import { TaskBridgeHandoff } from './TaskBridgeHandoff';
import { AgentBridgesPage } from './AgentBridgesPage';

vi.mock('../api/agent-bridges', () => ({ bridgeApi: { devices: vi.fn(), handoffs: vi.fn(), dispatch: vi.fn(), cancel: vi.fn(), adopt: vi.fn(), pairing: vi.fn(), approve: vi.fn(), revoke: vi.fn() } }));
const state = vi.hoisted(() => ({ eligibility: {} as Record<string, unknown>, actor: 'u1' }));
vi.mock('./useTaskAgentEligibility', () => ({ useTaskAgentEligibility: () => state.eligibility }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: state.actor } }) }));
const task = { taskId: 't1', revision: 3, assigneeId: 'u1' } as CollaborationTask;
const device = { deviceId: 'd1', deviceName: 'My DSH', paired: true, revoked: false, protocolVersion: 1, projects: [{ projectId: 'p1', name: '项目', workspaceLabel: '研究' }] };
const row = (state: BridgeHandoff['state'], extra: Partial<BridgeHandoff> = {}): BridgeHandoff => ({ handoffId: 'h1', taskId: 't1', projectId: 'p1', taskRevision: 3, deviceId: 'd1', state, reason: null, snapshotHash: 'hash', sessionId: 's1', result: null, createdAt: '', updatedAt: '', ...extra });
function mount(content: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{content}</MemoryRouter></QueryClientProvider>) };
}
function progress(item: BridgeHandoff) {
  vi.mocked(bridgeApi.handoffs).mockResolvedValue({ items: [item] });
  return mount(<TaskBridgeHandoff projectId="p1" task={task}><p>手动导出</p></TaskBridgeHandoff>);
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); state.actor = 'u1';
  state.eligibility = { eligible: false, pending: false, loading: false, readError: false, canCheck: true, check: vi.fn(), result: { status: 'missing', taskRevision: 3 }, reason: '尚未检查' };
  vi.mocked(bridgeApi.devices).mockResolvedValue({ items: [device] });
  vi.mocked(bridgeApi.handoffs).mockResolvedValue({ items: [] });
  vi.mocked(bridgeApi.dispatch).mockResolvedValue(row('checking'));
});
afterEach(cleanup);
describe('DSH assistance delegation', () => {
  it('opens the assistance card without dispatching even with a bound device', () => {
    const open = vi.fn(); mount(<TaskAgentAction projectId="p1" task={task} onHandoff={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 辅助' }));
    expect(open).toHaveBeenCalledOnce(); expect(bridgeApi.dispatch).not.toHaveBeenCalled();
  });
  it('requires a fresh eligible judgment, then dispatches once from the explicit execution button', async () => {
    state.eligibility = { ...state.eligibility, eligible: true, result: { status: 'ready', taskRevision: 3, eligible: true } };
    progress(row('cancelled'));
    const button = await screen.findByRole('button', { name: '重新代实施' });
    await waitFor(() => expect(button).toBeEnabled()); expect(bridgeApi.dispatch).not.toHaveBeenCalled();
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(bridgeApi.dispatch).toHaveBeenCalledExactlyOnceWith('p1', 't1', 3, 'd1', 'u1'));
    expect(state.eligibility.check).not.toHaveBeenCalled();
  });
  it.each(['missing', 'queued', 'running', 'failed', 'disabled'])('blocks delegation while eligibility is %s', async status => {
    state.eligibility = { ...state.eligibility, result: { status, taskRevision: 3 } };
    progress(row('cancelled')); const button = await screen.findByRole('button', { name: '重新代实施' });
    expect(button).toBeDisabled(); fireEvent.click(button); expect(bridgeApi.dispatch).not.toHaveBeenCalled();
  });
  it('preserves the human task refusal within delegation', async () => {
    state.eligibility = { ...state.eligibility, result: { status: 'ready', taskRevision: 3, eligible: false }, reason: '此任务暂不支持代实施。' };
    progress(row('cancelled')); await screen.findByText('此任务暂不支持代实施。');
    expect(screen.getByRole('button', { name: '重新代实施' })).toBeDisabled();
  });
  it('does not render eligibility conclusions from a blocked bridge handoff', async () => {
    progress(row('blocked', { reason: '任务需核对在读身份及作者学院归属，AI无法独立核验。' }));
    await screen.findByText('无法交给 AI 执行');
    expect(screen.queryByText(/任务需核对在读身份/)).toBeNull();
  });
  it('resumes an existing session without another dispatch', async () => {
    progress(row('running')); await screen.findByText('Agent 正在执行');
    expect(bridgeApi.dispatch).not.toHaveBeenCalled();
  });
  it('reports a dispatch network failure without showing false progress', async () => {
    state.eligibility = { ...state.eligibility, eligible: true, result: { status: 'ready', taskRevision: 3, eligible: true } };
    vi.mocked(bridgeApi.dispatch).mockRejectedValue(new Error('连接中断'));
    progress(row('cancelled')); const button = await screen.findByRole('button', { name: '重新代实施' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    await screen.findByText('连接中断'); expect(bridgeApi.dispatch).toHaveBeenCalledOnce();
  });
  it('ignores a late dispatch after the logged-in actor changes', async () => {
    state.eligibility = { ...state.eligibility, eligible: true, result: { status: 'ready', taskRevision: 3, eligible: true } };
    let finish!: (item: BridgeHandoff) => void;
    vi.mocked(bridgeApi.dispatch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = progress(row('cancelled')); const button = await screen.findByRole('button', { name: '重新代实施' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); await waitFor(() => expect(finish).toBeDefined());
    state.actor = 'u2'; vi.mocked(bridgeApi.handoffs).mockResolvedValue({ items: [] });
    view.rerender(<QueryClientProvider client={view.client}><MemoryRouter><TaskBridgeHandoff projectId="p1" task={task}><p>手动导出</p></TaskBridgeHandoff></MemoryRouter></QueryClientProvider>);
    finish(row('checking'));
    await waitFor(() => expect(view.client.getQueryData(['agent-bridge-handoffs', 'p1', 't1', 'u2'])).toEqual({ items: [] }));
    expect(view.client.getQueryData(['agent-bridge-handoffs', 'p1', 't1', 'u1'])).toEqual({ items: [row('cancelled')] });
  });
});
describe('DSH bridge review', () => {
  const result = { summary: '已完成研究稿', artifacts: [{ artifactId: 'a1', fileId: 'f1', name: 'report.md', sizeBytes: 15, sha256: 'hash' }] };
  it('requires manual review and deduplicates submission', async () => {
    vi.mocked(bridgeApi.adopt).mockResolvedValue({ submission: {} }); progress(row('ready_for_review', { result }));
    const submit = await screen.findByRole('button', { name: '采纳并提交验收' }); expect(submit).toBeDisabled();
    expect(screen.getByRole('link', { name: 'report.md' })).toHaveAttribute('href', '/api/v1/projects/p1/files/f1/content');
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(submit); fireEvent.click(submit);
    await screen.findByRole('button', { name: '已提交验收' }); expect(bridgeApi.adopt).toHaveBeenCalledExactlyOnceWith('h1', 3, 'u1');
  });
  it.each([{ taskRevision: 2 }, { stale: true }])('preserves stale drafts while blocking submission %j', async extra => {
    progress(row('ready_for_review', { ...extra, result })); await screen.findByText(/依据旧版本/);
    expect(screen.getByRole('button', { name: '采纳并提交验收' })).toBeDisabled(); expect(screen.getByDisplayValue('已完成研究稿')).toBeVisible();
  });
  it('blocks a different actor from submitting without hiding the draft', async () => {
    state.actor = 'u2'; progress(row('ready_for_review', { result }));
    await screen.findByText(/仅任务执行人/); expect(screen.getByRole('checkbox')).toBeDisabled(); expect(bridgeApi.adopt).not.toHaveBeenCalled();
  });
  it('keeps cancellation pending until device acknowledgment', async () => {
    vi.mocked(bridgeApi.cancel).mockResolvedValue(row('cancel_requested'));
    progress(row('running')); const cancel = await screen.findByRole('button', { name: '取消交接' });
    vi.mocked(bridgeApi.handoffs).mockResolvedValue({ items: [row('cancel_requested')] }); fireEvent.click(cancel);
    await screen.findByText('等待 DSH 确认取消'); expect(screen.queryByRole('button', { name: '取消交接' })).toBeNull();
  });
  it('explains uncertain execution and never dispatches automatically', async () => {
    progress(row('dispatch_uncertain')); await screen.findByText(/请勿重复执行/); expect(bridgeApi.dispatch).not.toHaveBeenCalled();
  });
});
describe('DSH pairing', () => {
  it('requires project selection before an explicit approval', async () => {
    vi.mocked(bridgeApi.pairing).mockResolvedValue({ pairingId: 'pair1', deviceName: 'Laptop', status: 'pending', expiresAt: new Date(Date.now() + 100_000).toISOString(), projects: [{ projectId: 'p1', name: '项目一' }] });
    vi.mocked(bridgeApi.approve).mockResolvedValue({ pairingId: 'pair1', deviceName: 'Laptop', status: 'approved', expiresAt: '' });
    mount(<AgentBridgesPage />, '/app/agent-bridges/connect?pairing=pair1');
    const button = await screen.findByRole('button', { name: '确认连接并授权项目' }); expect(button).toBeDisabled(); expect(bridgeApi.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '项目一' })); fireEvent.click(button);
    await screen.findByText(/连接已授权/); expect(bridgeApi.approve).toHaveBeenCalledExactlyOnceWith('pair1', ['p1'], 'u1');
  });
  it('does not authorize an expired pairing', async () => {
    vi.mocked(bridgeApi.pairing).mockResolvedValue({ pairingId: 'pair1', deviceName: 'Laptop', status: 'expired', expiresAt: '2020-01-01', projects: [] });
    mount(<AgentBridgesPage />, '/app/agent-bridges/connect?pairing=pair1'); await screen.findByText(/连接请求已过期/); expect(screen.queryByRole('button', { name: '确认连接并授权项目' })).toBeNull();
  });
});
