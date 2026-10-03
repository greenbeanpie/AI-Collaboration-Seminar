import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { CollaborationWorkspace } from './CollaborationWorkspace';
import { CollaborationSettings } from './CollaborationSettings';
const identity = vi.hoisted(() => ({ role: 'owner', aiEnabled: false, projectId: 'p1' }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: identity.projectId, project: { myRole: identity.role } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: identity.aiEnabled } } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); identity.role = 'owner'; identity.aiEnabled = false; identity.projectId = 'p1'; });
const task = { pendingHumanReview: false, startedAt: null as string | null, dependsOnTaskIds: [] as string[], unfinishedDependencyIds: [] as string[], status: 'doing' as 'todo' | 'doing' | 'blocked' | 'done', citations: [] as Array<{ sourceVersionId: string; fragmentId: string; pageNumber: number | null; quote: string }>, taskId: 't1', title: '交付原型', detail: '完成交互', criteria: '完成三个可操作页面', effortHours: 4, revision: 3, assigneeId: 'm1' as string | null, lifecycleState: 'in_progress', currentSubmissionId: null as string | null };
const submission = { submissionId: 's1', taskId: 't1', round: 1, submittedBy: 'm1', body: '已完成三个页面', materialVersionIds: ['v1'], criteria: '完成三个可操作页面', status: 'pending', decision: null, aiDecision: null, aiFeedback: null, feedback: null, revision: 2, createdAt: '2026-10-01T00:00:00Z' };
function setup({ tasks = [task], submissions = [] as unknown[], proposals = [] as unknown[], component = 'workspace', entries = ['/tasks'] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['project-feedback', 'p1'], {versionId:null,version:0,feedback:'',actorId:null,createdAt:null});
  client.setQueryData(['project-feedback-history','p1'],{items:[]});
  client.setQueryData(['project-assistant-sources', 'p1'], []);
  client.setQueryData(['project-goal', 'p1'], { projectId: 'p1', title: '共同目标', detail: '', revision: 1, graphRevision: 9 });
  client.setQueryData(['collaboration-tasks', 'p1'], { items: tasks });
  client.setQueryData(['collaboration-settings', 'p1'], { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', revision: 7 });
  client.setQueryData(['collaboration-proposals', 'p1'], { items: proposals });
  client.setQueryData(['collaboration-submissions', 'p1', 't1'], { items: submissions });
  client.setQueryData(['members', 'p1'], [{ userId: 'm1', displayName: '成员甲' }]);
  client.setQueryData(['member-me', 'p1'], { userId: 'm1' });
  client.setQueryData(['materials', 'p1'], [{ materialId: 'mat1', title: '原型说明' }]);
  client.setQueryData(['materialVersions', 'p1', 'mat1'], [{ versionId: 'v1', revision: 4, createdAt: '2026-10-01T00:00:00Z', attachments: [] }]);
  const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => new Response(JSON.stringify({ data: options?.method === 'PATCH' ? { aiCollaborationEnabled: false, assignmentMode: 'automatic', evaluationMode: 'manual', revision: 8 } : { ...task, items: [], nextCursor: null, ...submission }, requestId: 'r1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}><NavigationProbe />{component === 'settings' ? <CollaborationSettings /> : <CollaborationWorkspace />}</MemoryRouter></QueryClientProvider>);
  return { client, fetchMock, view };
}
function NavigationProbe() { const location = useLocation(); const navigate = useNavigate(); return <><output data-testid="location">{location.search}</output><button onClick={() => navigate(-1)}>返回前页</button></>; }
describe('collaboration lifecycle', () => {
  it('uses task terminology and keeps task settings free of retired hierarchy controls', () => {
    setup({ tasks: [task, { ...task, taskId: 't2', title: '整理依据', dependsOnTaskIds: ['t1'] }] });
    expect(screen.getByRole('heading', { name: '任务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '全部任务' })).toBeInTheDocument();
    expect(screen.queryByText(/历史父任务|子任务/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]!);
    expect(screen.getByRole('dialog', { name: '交付原型 · 任务设置' })).toBeInTheDocument();
    expect(screen.queryByText('任务进度')).toBeNull();
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: '前置依赖' })).toBeInTheDocument();
  });
  it('counts provisional completion and exposes its pending review filter and owner review action', () => {
    const pending = { ...task, pendingHumanReview: true, lifecycleState: 'accepted', status: 'done' as const, currentSubmissionId: 's1' };
    const approved = { ...task, taskId: 't2', title: '正式审核通过的成果', lifecycleState: 'accepted', status: 'done' as const };
    setup({ tasks: [pending, approved], submissions: [{ ...submission, status: 'accept', decision: 'accept', aiDecision: 'accept', pendingHumanReview: true }] });
    expect(screen.getByText('共 2 项 · 已完成 2 项')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('筛选'), { target: { value: 'pending_review' } });
    expect(screen.getByRole('button', { name: task.title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: approved.title })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.getByRole('heading', { name: '人工审核' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认人工审核' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('第 1 轮验收理由'), { target: { value: '已人工核对附件' } });
    expect(screen.getByRole('button', { name: '确认人工审核' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.change(screen.getByLabelText('筛选'), { target: { value: 'accepted' } });
    expect(screen.queryByRole('button', { name: task.title })).toBeNull();
    expect(screen.getByRole('button', { name: approved.title })).toBeInTheDocument();
  });
  it('lets ordinary members see provisional completion without granting human-review controls', () => {
    identity.role = 'member';
    setup({ tasks: [{ ...task, pendingHumanReview: true, lifecycleState: 'accepted', status: 'done' as const, currentSubmissionId: 's1' }], submissions: [{ ...submission, status: 'accept', decision: 'accept', pendingHumanReview: true }] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(within(screen.getByRole('dialog')).getAllByText('已完成（待人工审核）').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '确认人工审核' })).toBeNull();
  });
  it('opens inquiries as a sibling action without embedding inquiries or tabs in task dialogs', async () => {
    const { fetchMock } = setup();
    expect(screen.getByRole('button', { name: '前置任务质询' }).parentElement).toBe(screen.getByRole('button', { name: '查看与提交' }).parentElement);
    expect(screen.getByRole('button', { name: '交给本地 Agent' }).parentElement).toBe(screen.getByRole('button', { name: '查看与提交' }).parentElement);
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(within(screen.getByRole('dialog')).queryByRole('region', { name: '前置任务质询' })).toBeNull();
    expect(within(screen.getByRole('dialog')).queryByRole('tablist')).toBeNull();
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '保留执行草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '前置任务质询' }));
    expect(screen.getByRole('dialog', { name: '前置任务质询' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/tasks/t1/inquiries'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '任务设置' }));
    expect(screen.getByRole('dialog', { name: '交付原型 · 任务设置' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.getByLabelText('成果说明')).toHaveValue('保留执行草稿');
  });
  it('places AI controls in the creation toolbar and preserves the draft when collapsed', () => {
    setup();
    const toggle = screen.getByRole('button', { name: 'AI 拆解、调整与分工' });
    expect(toggle.nextElementSibling).toBe(screen.getByRole('button', { name: '新建任务' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '重新生成整套任务建议' })).toBeNull();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('持续项目反馈'), { target: { value: '保留拆解草稿' } });
    expect(screen.getByRole('dialog', { name: 'AI 拆解、调整与分工' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('持续项目反馈')).toHaveValue('保留拆解草稿');
    expect(screen.getByRole('dialog')).toContainElement(screen.getByLabelText('持续项目反馈'));
  });
  it('filters with an inline label and retains focusable dependency guidance next to status', () => {
    const { view } = setup({ tasks: [task, { ...task, taskId: 't2', title: '待采集', assigneeId: null, lifecycleState: 'open', unfinishedDependencyIds: ['t1'], dependsOnTaskIds: ['t1'] }] });
    const warning = screen.getByLabelText('前置任务未完成，可提前认领、执行和提交。');
    expect(warning).toHaveAttribute('tabindex', '0');
    expect(warning.parentElement).toHaveClass('collab-task-status');
    expect(view.container.querySelector('.collab-task > p.notice')).toBeNull();
    expect(view.container.querySelectorAll('.collab-task-footer')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('筛选'), { target: { value: 'open' } });
    expect(screen.queryByRole('button', { name: '交付原型' })).toBeNull();
    expect(screen.getByRole('button', { name: '待采集' })).toBeInTheDocument();
  });
  it('labels the task introduction and places the dependency editor before its heading', () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    expect(screen.getByRole('heading', { name: '任务介绍' })).toBeInTheDocument();
    expect(screen.queryByText(/执行人：/)).toBeNull();
    const toggle = screen.getByRole('button', { name: '调整前置任务' });
    expect(toggle.nextElementSibling).toBe(screen.getByRole('heading', { name: '前置依赖' }));
    expect(screen.queryByRole('button', { name: '保存前置依赖' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '保存前置依赖' })).toBeInTheDocument();
  });
  it('keeps AI and task creation controls unavailable to ordinary members', () => {
    identity.role = 'member'; const { fetchMock } = setup();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/ai/clarifications'))).toBe(false);
    fireEvent.click(screen.getByRole('button', {name:'AI 拆解、调整与分工'}));
    expect(screen.getByLabelText('持续项目反馈')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button',{name:'保存反馈'})).toBeNull();
    expect(screen.getByRole('button',{name:'重新生成整套任务建议'})).toBeDisabled();
    expect(screen.queryByRole('button', { name: '新建任务' })).toBeNull();
  });
  it('opens history directly from the submission toolbar, pages one submission, and preserves drafts', () => {
    setup({ tasks: [{ ...task, lifecycleState: 'improve', currentSubmissionId: 's3' }], submissions: [submission, { ...submission, submissionId: 's3', round: 3, body: '第三轮真实内容' }, { ...submission, submissionId: 's2', round: 2, body: '第二轮真实内容' }] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.queryByRole('tablist')).toBeNull(); expect(screen.getByRole('region', { name: '查看与提交' })).toBeVisible();
    expect(screen.queryByText('上一轮提交 · 第 3 轮')).toBeNull();
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '未提交草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    expect(screen.queryByRole('button', { name: '提交本轮成果' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看历史记录' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.queryByRole('button', { name: /更多/ })).toBeNull();
    expect(screen.getByRole('button', { name: '查看历史记录' }).closest('.collab-toolbar')).not.toBeNull();
    expect(screen.queryByRole('region', { name: '提交与验收历史' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看历史记录' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('view=history');
    const historySection = screen.getByRole('region', { name: '提交与验收历史' });
    expect(historySection.querySelectorAll('.collab-history')).toHaveLength(1);
    expect(screen.getByLabelText('选择提交轮次')).toHaveValue('s3');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByLabelText('选择提交轮次')).toHaveValue('s2');
    fireEvent.change(screen.getByLabelText('选择提交轮次'), { target: { value: 's1' } });
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '返回任务操作' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.getByLabelText('成果说明')).toHaveValue('未提交草稿');
  });

  it('pins a directly linked submission while newer records arrive', async () => {
    const { client } = setup({ submissions: [submission], entries: ['/tasks?task=t1&view=history&historyType=submissions&record=s1'] });
    expect(screen.getByLabelText('选择提交轮次')).toHaveValue('s1');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    act(() => client.setQueryData(['collaboration-submissions', 'p1', 't1'], { items: [submission, { ...submission, submissionId: 's2', round: 2 }] }));
    expect(screen.getByLabelText('选择提交轮次')).toHaveValue('s1');
    await waitFor(() => expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: '确认验收决定' })).toBeNull();
  });
  it('displays empty history and returns to a task dialog', () => {
    setup({ entries: ['/tasks?task=t1&view=history&historyType=submissions'] });
    expect(within(screen.getByRole('region', { name: '提交与验收历史' })).getByText('尚未提交成果。')).toBeVisible();
    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回任务操作' }));
    expect(screen.getByRole('dialog', { name: '交付原型' })).toBeInTheDocument();
  });
  it('returns from history via browser navigation without discarding the submission draft', () => {
    setup({ submissions: [submission] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '返回后保留' } });
    fireEvent.click(screen.getByRole('button', { name: '查看历史记录' }));
    fireEvent.click(screen.getByRole('button', { name: '返回前页' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('成果说明')).toHaveValue('返回后保留');
  });
  it('pages one AI proposal and retains AI input when returning', () => {
    const oldProposal = { proposalId: 'p-old', kind: 'assign', status: 'applied', revision: 1, payload: { assignments: [] }, createdAt: '2026-10-01T00:00:00Z' };
    const { client } = setup({ proposals: [oldProposal, { ...oldProposal, proposalId: 'p-new', createdAt: '2026-10-02T00:00:00Z' }] });
    fireEvent.click(screen.getByRole('button', { name: 'AI 拆解、调整与分工' }));
    fireEvent.change(screen.getByLabelText('持续项目反馈'), { target: { value: '保留 AI 要求' } });
    fireEvent.click(screen.getByRole('button', { name: '历史记录' }));
    const region = screen.getByRole('region', { name: 'AI 拆解、调整与分工' });
    expect(within(region).getAllByRole('article')).toHaveLength(1);
    expect(screen.getByLabelText('选择建议记录')).toHaveValue('p-new');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByLabelText('选择建议记录')).toHaveValue('p-old');
    act(() => client.setQueryData(['collaboration-proposals', 'p1'], { items: [oldProposal, { ...oldProposal, proposalId: 'p-later', createdAt: '2026-10-03T00:00:00Z' }] }));
    expect(screen.getByLabelText('选择建议记录')).toHaveValue('p-old');
    expect(within(region).queryByRole('button', { name: '应用选中条目' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回任务操作' }));
    expect(screen.getByLabelText('持续项目反馈')).toHaveValue('保留 AI 要求');
  });

  it('retains a pending owner decision when browsing read-only history', () => {
    setup({ tasks: [{ ...task, lifecycleState: 'submitted', currentSubmissionId: 's1' }], submissions: [submission] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('第 1 轮验收理由'), { target: { value: '待提交验收理由' } });
    fireEvent.click(screen.getByRole('button', { name: '查看历史记录' }));
    expect(screen.queryByRole('button', { name: '确认验收决定' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回任务操作' }));
    expect(screen.getByLabelText('第 1 轮验收理由')).toHaveValue('待提交验收理由');
  });

  it('keeps polling an AI job after the dialog closes and restores its completed progress', async () => {
    identity.aiEnabled = true;
    const { client, fetchMock } = setup();
    act(() => client.setQueryData(['collaboration-settings', 'p1'], { aiCollaborationEnabled: true, assignmentMode: 'manual', evaluationMode: 'manual', revision: 7 }));
    const fallback = fetchMock.getMockImplementation()!;
    let status = 'running';
    fetchMock.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/collaboration/feedback/current')) return Response.json({data:{version:1,versionId:'v1',feedback:'创建交付任务',actorId:'m1',createdAt:'2026-10-03'},requestId:'r1'});
      if (String(url).endsWith('/collaboration/decompose') || String(url).endsWith('/jobs/j1')) {
        return new Response(JSON.stringify({ data: { jobId: 'j1', status, result: null }, requestId: 'r1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fallback(url, options);
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI 拆解、调整与分工' }));
    fireEvent.change(screen.getByLabelText('持续项目反馈'), { target: { value: '创建交付任务' } });
    fireEvent.click(screen.getByRole('button', { name: '按要求调整现有任务' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/jobs/j1'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    status = 'succeeded';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/jobs/j1')).length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: 'AI 拆解、调整与分工' }));
    await waitFor(() => expect(screen.getByText(/AI 任务：.*完成/)).toBeVisible());
    expect(screen.getByLabelText('持续项目反馈')).toHaveValue('创建交付任务');
  });

  it('keeps older pending proposals actionable and pins unsaved correction drafts', async () => {
    const old = { proposalId: 'older', kind: 'assign', status: 'pending', revision: 1, payload: { assignments: [] }, createdAt: '2026-10-01T00:00:00Z' };
    const latest = { ...old, proposalId: 'latest', createdAt: '2026-10-02T00:00:00Z' };
    const { client } = setup({ proposals: [old, latest] });
    fireEvent.click(screen.getByRole('button', { name: 'AI 拆解、调整与分工' }));
    fireEvent.click(screen.getByText('修正建议、部分应用或重新反馈'));
    fireEvent.change(screen.getByLabelText('修正理由或重新反馈'), { target: { value: '未保存的方案修正' } });
    act(() => client.setQueryData(['collaboration-proposals', 'p1'], { items: [old, latest, { ...old, proposalId: 'newest', createdAt: '2026-10-03T00:00:00Z' }] }));
    await waitFor(() => expect(screen.getByLabelText('修正理由或重新反馈')).toHaveValue('未保存的方案修正'));
    fireEvent.click(screen.getByRole('button', { name: '历史记录' }));
    fireEvent.change(screen.getByLabelText('选择建议记录'), { target: { value: 'older' } });
    expect(screen.queryByRole('button', { name: '应用选中条目' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开此建议进行处理' }));
    fireEvent.click(screen.getByText('修正建议、部分应用或重新反馈'));
    expect(screen.getByRole('button', { name: '应用选中条目' })).toBeEnabled();
  });

  it('preserves legacy completion and never creates fabricated submissions', () => {
    const { fetchMock } = setup({ tasks: [{ ...task, status: 'done', lifecycleState: 'accepted', currentSubmissionId: null }] });
    expect(screen.getByText('历史已完成')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.getByText('历史完成状态已保留，未补造提交与验收记录。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交本轮成果' })).toBeNull();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('allows early submission while displaying unfinished predecessors', async () => {
    const { fetchMock } = setup({ tasks: [{ ...task, dependsOnTaskIds: ['older-task'], unfinishedDependencyIds: ['older-task'] }] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    expect(screen.getByText(/尚未完成：older-task/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '提前提交真实成果' } });
    expect(screen.getByRole('button', { name: '提交本轮成果' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/tasks/t1/submissions') && options?.method === 'POST')).toBe(true));
  });
  it('holds dependency changes against their graph revision until a conflicting graph is reloaded', async () => {
    const { client, fetchMock } = setup({ tasks: [task, { ...task, taskId: 't2', title: '前置资料整理', assigneeId: null, lifecycleState: 'open' }] });
    fireEvent.click(screen.getAllByRole('button', { name: '查看与提交' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '调整前置任务' }));
    const selection = screen.getByLabelText('前置资料整理');
    fireEvent.click(selection);
    act(() => client.setQueryData(['project-goal', 'p1'], { projectId: 'p1', title: '共同目标', revision: 1, graphRevision: 10 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存前置依赖' })).toBeDisabled());
    expect(selection).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存前置依赖' }));
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '载入最新依赖' }));
    expect(selection).not.toBeChecked();
    fireEvent.click(selection); fireEvent.click(screen.getByRole('button', { name: '保存前置依赖' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true));
    const call = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ expectedGraphRevision: 10, dependsOnTaskIds: ['t2'] });
  });
  it('keeps manual creation available while AI is disabled', async () => {
    const { fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'AI 拆解、调整与分工' }));
    expect(screen.getByRole('button', { name: '重新生成整套任务建议' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '校对文稿' } });
    fireEvent.change(screen.getByLabelText(/^验收标准/), { target: { value: '无错字并保留核对清单' } });
    fireEvent.change(screen.getByLabelText('预计投入（小时）'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/projects/p1/tasks') && opts?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith('/projects/p1/tasks') && opts?.method === 'POST')!;
    expect(String(call[0])).toContain('/projects/p1/tasks');
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ title: '校对文稿', criteria: '无错字并保留核对清单', effortHours: 2 });
  });
  it('claims atomically using the displayed task revision', async () => {
    const { fetchMock } = setup({ tasks: [{ ...task, assigneeId: null, lifecycleState: 'open' }] });
    fireEvent.click(screen.getByRole('button', { name: '我来认领' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/claim') && opts?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/claim'))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 3 });
  });
  it('binds an immutable version to the submission', async () => {
    const { fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '三个页面已联调' } });
    fireEvent.change(screen.getByLabelText(/^绑定材料版本/), { target: { value: 'mat1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /r4/ }));
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
  it('shows fixed-source provenance directly in a grounded task detail', () => {
    const citations = [{ sourceVersionId: 'source-version', fragmentId: 'fragment', pageNumber: 2, quote: '原始资料要求支持键盘操作。' }];
    setup({ tasks: [{ ...task, citations }] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    expect(screen.getByText('任务来源原文依据')).toBeInTheDocument();
    expect(screen.getByText(/原始资料要求支持键盘操作/)).toBeInTheDocument();
    expect(screen.queryByText(/后续人工调整标准时/)).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    fireEvent.change(screen.getByLabelText('调整验收标准'), { target: { value: '增加键盘操作验收' } });
    fireEvent.click(screen.getByRole('button', { name: '保存任务调整' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) => String(url).endsWith('/tasks/t1') && opts?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith('/tasks/t1') && opts?.method === 'PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 3, title: '交付原型', detail: '完成交互', criteria: '增加键盘操作验收', effortHours: 4 });
  });
  it('pins task edits to their base revision until explicitly reloaded', async () => {
    const { client, fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    fireEvent.change(screen.getByLabelText('调整验收标准'), { target: { value: '旧版草稿' } });
    act(() => { client.setQueryData(['project-goal', 'p1'], { projectId: 'p1', title: '共同目标', detail: '', revision: 1, graphRevision: 9 });
  client.setQueryData(['collaboration-tasks', 'p1'], { items: [{ ...task, revision: 4, criteria: '另一成员的新标准' }] }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存任务调整' })).toBeDisabled());
    expect(screen.getByLabelText('调整验收标准')).toHaveValue('旧版草稿');
    fireEvent.click(screen.getByRole('button', { name: '保存任务调整' }));
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'PATCH')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '重新载入最新任务' }));
    expect(screen.getByLabelText('调整验收标准')).toHaveValue('另一成员的新标准');
    fireEvent.click(screen.getByRole('button', { name: '保存任务调整' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ expectedRevision: 4, criteria: '另一成员的新标准' });
  });
  it('does not silently rebase an owner assignment over a newer claim', async () => {
    const { client, fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); fireEvent.click(screen.getAllByRole('button', { name: '任务设置' })[0]);
    fireEvent.change(screen.getByLabelText('分工理由'), { target: { value: '旧分工理由' } });
    act(() => { client.setQueryData(['project-goal', 'p1'], { projectId: 'p1', title: '共同目标', detail: '', revision: 1, graphRevision: 9 });
  client.setQueryData(['collaboration-tasks', 'p1'], { items: [{ ...task, revision: 4, assigneeId: 'someone-else' }] }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '确认分工' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '确认分工' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assign'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '重新载入当前分工' }));
    expect(screen.getByLabelText('分工理由')).toHaveValue('');
  });
  it('requires fresh review before submitting a draft against changed criteria', async () => {
    const { client, fetchMock } = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '旧标准成果' } });
    act(() => { client.setQueryData(['project-goal', 'p1'], { projectId: 'p1', title: '共同目标', detail: '', revision: 1, graphRevision: 9 });
  client.setQueryData(['collaboration-tasks', 'p1'], { items: [{ ...task, revision: 4, criteria: '增加无障碍检查' }] }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '提交本轮成果' })).toBeDisabled());
    expect(screen.getByLabelText('成果说明')).toHaveValue('旧标准成果');
    fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
    expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '已核对标准，重新填写本轮提交' }));
    expect(screen.getByLabelText('成果说明')).toHaveValue('');
  });
  it('pins an owner decision to the reviewed submission revision', async () => {
    const { client, fetchMock } = setup({ tasks: [{ ...task, lifecycleState: 'submitted', currentSubmissionId: 's1' }], submissions: [submission] });
    fireEvent.click(screen.getByRole('button', { name: '查看与提交' }));
    fireEvent.change(screen.getByLabelText('第 1 轮验收理由'), { target: { value: '旧评价结论' } });
    act(() => { client.setQueryData(['collaboration-submissions', 'p1', 't1'], { items: [{ ...submission, revision: 3, status: 'evaluated', aiDecision: 'improve', aiFeedback: '新增缺口' }] }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '确认验收决定' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '确认验收决定' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/decide'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '已核对最新评价，重新填写决定' }));
    expect(screen.getByLabelText('第 1 轮验收理由')).toHaveValue('');
  });
  it('does not rebase a local mode change over refreshed collaboration settings', async () => {
    const { client, fetchMock } = setup({ component: 'settings' });
    fireEvent.change(screen.getByLabelText('分工方式'), { target: { value: 'automatic' } });
    act(() => { client.setQueryData(['collaboration-settings', 'p1'], { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'automatic', revision: 8 }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存协作规则' })).toBeDisabled());
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新载入协作规则' }));
    expect(screen.getByLabelText('分工方式')).toHaveValue('manual');
    expect(screen.getByLabelText('成果验收方式')).toHaveValue('automatic');
  });
  it('resets open drafts and task details when changing projects', () => {
    const { client, view } = setup();
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '旧项目草稿' } });
    for (const key of ['collaboration-tasks', 'collaboration-proposals']) client.setQueryData([key, 'p2'], { items: [] });
    client.setQueryData(['collaboration-settings', 'p2'], { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual', revision: 1 });
    client.setQueryData(['members', 'p2'], []);
    client.setQueryData(['project-goal', 'p2'], { projectId: 'p2', title: '第二个目标', detail: '', revision: 1, graphRevision: 1 });
    client.setQueryData(['member-me', 'p2'], { userId: 'm1' });
    identity.projectId = 'p2';
    view.rerender(<QueryClientProvider client={client}><MemoryRouter><NavigationProbe /><CollaborationWorkspace /></MemoryRouter></QueryClientProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    expect(screen.getByLabelText('任务名称')).toHaveValue('');
    expect(screen.queryByText('交付原型')).not.toBeInTheDocument();
  });
  it('saves assignment and evaluation modes independently', async () => {
    const { fetchMock } = setup({ component: 'settings' });
    fireEvent.change(screen.getByLabelText('分工方式'), { target: { value: 'automatic' } });
    fireEvent.click(screen.getByRole('button', { name: '保存协作规则' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 7, aiCollaborationEnabled: false, assignmentMode: 'automatic', evaluationMode: 'manual' });
  });
});

it('does not start AI when permanent feedback saving fails', async()=>{
 identity.aiEnabled=true;const {client,fetchMock}=setup();
 act(()=>client.setQueryData(['collaboration-settings','p1'],{aiCollaborationEnabled:true,assignmentMode:'manual',evaluationMode:'manual',revision:7}));
 const fallback=fetchMock.getMockImplementation()!;
 fetchMock.mockImplementation(async(url,options)=>String(url).endsWith('/collaboration/feedback/current') ? Response.json({error:{code:'VERSION_CONFLICT',message:'反馈已变化'},requestId:'r'},{status:409}) : fallback(url,options));
 fireEvent.click(screen.getByRole('button',{name:'AI 拆解、调整与分工'}));
 fireEvent.change(screen.getByLabelText('持续项目反馈'),{target:{value:'新的持续要求'}});
 fireEvent.click(screen.getByRole('button',{name:'按要求调整现有任务'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'重新载入已保存反馈'})).toBeInTheDocument());
 expect(fetchMock.mock.calls.some(([path])=>String(path).endsWith('/collaboration/decompose'))).toBe(false);
 expect(screen.getByLabelText('持续项目反馈')).toHaveValue('新的持续要求');
});

it('does not regenerate a task that was started and returned to the open state', () => {
 identity.aiEnabled=true;
 const { client }=setup({tasks:[{...task,status:'todo',lifecycleState:'open',assigneeId:null,startedAt:'2026-10-03T01:00:00Z'}]});
 act(()=>client.setQueryData(['collaboration-settings','p1'],{aiCollaborationEnabled:true,assignmentMode:'manual',evaluationMode:'manual',revision:7}));
 fireEvent.click(screen.getByRole('button',{name:'AI 拆解、调整与分工'}));
 expect(screen.getByRole('button',{name:'重新生成整套任务建议'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'按要求调整现有任务'})).toBeEnabled();
});
