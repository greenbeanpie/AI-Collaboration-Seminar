import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { CollaborationWorkspace } from './CollaborationWorkspace';
import { CollaborationSettings } from './CollaborationSettings';
const identity = vi.hoisted(() => ({ role: 'owner', aiEnabled: false }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p1', project: { myRole: identity.role } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: identity.aiEnabled } } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); identity.role = 'owner'; identity.aiEnabled = false; });
const task = { taskId: 't1', title: '交付原型', detail: '完成交互', criteria: '完成三个可操作页面', effortHours: 4, revision: 3, assigneeId: 'm1' as string | null, lifecycleState: 'in_progress', parentTaskId: null, currentSubmissionId: null as string | null };
const submission = { submissionId: 's1', taskId: 't1', round: 1, submittedBy: 'm1', body: '已完成三个页面', materialVersionIds: ['v1'], criteria: '完成三个可操作页面', status: 'pending', decision: null, aiDecision: null, aiFeedback: null, feedback: null, revision: 2, createdAt: '2026-10-01T00:00:00Z' };
function setup({ tasks = [task], submissions = [] as unknown[], component = 'workspace', entries = ['/tasks'] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['collaboration-tasks', 'p1'], { items: tasks });
  client.setQueryData(['collaboration-settings', 'p1'], { assignmentMode: 'manual', evaluationMode: 'manual', revision: 7 });
  client.setQueryData(['collaboration-proposals', 'p1'], { items: [] });
  client.setQueryData(['collaboration-submissions', 'p1', 't1'], { items: submissions });
  client.setQueryData(['members', 'p1'], [{ userId: 'm1', displayName: '成员甲' }]);
  client.setQueryData(['member-me', 'p1'], { userId: 'm1' });
  client.setQueryData(['materials', 'p1'], [{ materialId: 'mat1', title: '原型说明' }]);
  client.setQueryData(['materialVersions', 'p1', 'mat1'], [{ versionId: 'v1', revision: 4, createdAt: '2026-10-01T00:00:00Z', attachments: [] }]);
  const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => new Response(JSON.stringify({ data: options?.method === 'PATCH' ? { assignmentMode: 'automatic', evaluationMode: 'manual', revision: 8 } : { ...task, items: [], ...submission }, requestId: 'r1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}><NavigationProbe />{component === 'settings' ? <CollaborationSettings /> : <CollaborationWorkspace />}</MemoryRouter></QueryClientProvider>);
  return { client, fetchMock };
}
function NavigationProbe() { const location = useLocation(); const navigate = useNavigate(); return <><output data-testid="location">{location.search}</output><button onClick={() => navigate(-1)}>返回前页</button></>; }
describe('collaboration lifecycle', () => {
  it('keeps manual creation available while AI is disabled', async () => {
    const { fetchMock } = setup();
    expect(screen.getByRole('button', { name: '生成拆解建议' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '新建协作任务' }));
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '校对文稿' } });
    fireEvent.change(screen.getByLabelText(/^验收标准/), { target: { value: '无错字并保留核对清单' } });
    fireEvent.change(screen.getByLabelText('预计投入（小时）'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '创建协作任务' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')!;
    expect(String(call[0])).toContain('/collaboration/tasks');
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ title: '校对文稿', criteria: '无错字并保留核对清单', effortHours: 2 });
  });
  it('claims atomically using the displayed task revision', async () => {
    const { fetchMock } = setup({ tasks: [{ ...task, assigneeId: null, lifecycleState: 'open' }] });
    fireEvent.click(screen.getByRole('button', { name: '我来认领' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/claim'))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 3 });
  });
  it('binds an immutable version to the submission', async () => {
    const { fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '三个页面已联调' } });
    fireEvent.change(screen.getByLabelText(/^绑定材料版本/), { target: { value: 'mat1' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/submissions') && opts?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith('/submissions') && opts?.method === 'POST')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 3, body: '三个页面已联调', materialVersionIds: ['v1'] });
  });
  it('requires explicit owner feedback and uses submission revision for a decision', async () => {
    const { fetchMock } = setup({ tasks: [{ ...task, lifecycleState: 'submitted', currentSubmissionId: 's1' }], submissions: [submission] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.getByRole('button', { name: '确认验收决定' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('第 1 轮验收结论'), { target: { value: 'improve' } });
    fireEvent.change(screen.getByLabelText('第 1 轮验收理由'), { target: { value: '补全移动端布局' } });
    fireEvent.click(screen.getByRole('button', { name: '确认验收决定' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/decide'))).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/decide'))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 2, decision: 'improve', feedback: '补全移动端布局' });
  });
  it('hides owner assignment and decisions from members', () => {
    identity.role = 'member';
    setup({ tasks: [{ ...task, lifecycleState: 'submitted', currentSubmissionId: 's1' }], submissions: [submission] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.queryByText('负责人分工')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认验收决定' })).not.toBeInTheDocument();
  });
  it('does not let the project owner submit for another assignee', () => {
    setup({ tasks: [{ ...task, assigneeId: 'another-member' }] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.queryByRole('button', { name: '提交本轮成果' })).not.toBeInTheDocument();
  });
  it('keeps both collaboration mode controls read-only for members', () => {
    identity.role = 'member';
    setup({ component: 'settings' });
    expect(screen.getByLabelText('分工方式')).toBeDisabled();
    expect(screen.getByLabelText('成果验收方式')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存协作规则' })).not.toBeInTheDocument();
  });
  it('opens a linked authorized task and clears the link on close', () => {
    setup({ entries: ['/tasks?task=t1'] });
    expect(screen.getByRole('dialog', { name: '交付原型' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('');
  });
  it('does not open a task absent from the authorized project list', () => {
    setup({ entries: ['/tasks?task=unknown-project-task'] });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('closes the linked modal when browser navigation removes the task parameter', () => {
    setup({ entries: ['/tasks', '/tasks?task=t1'] });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回前页' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('lets the owner correct actionable task criteria with its current revision', async () => {
    const { fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('调整验收标准'), { target: { value: '增加键盘操作验收' } });
    fireEvent.click(screen.getByRole('button', { name: '保存任务调整' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/tasks/t1') && opts?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith('/tasks/t1') && opts?.method === 'PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 3, title: '交付原型', detail: '完成交互', criteria: '增加键盘操作验收', effortHours: 4 });
  });
  it('saves assignment and evaluation modes independently', async () => {
    const { fetchMock } = setup({ component: 'settings' });
    fireEvent.change(screen.getByLabelText('分工方式'), { target: { value: 'automatic' } });
    fireEvent.click(screen.getByRole('button', { name: '保存协作规则' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 7, assignmentMode: 'automatic', evaluationMode: 'manual' });
  });
});
