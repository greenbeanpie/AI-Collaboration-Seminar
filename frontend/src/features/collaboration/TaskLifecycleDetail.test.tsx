import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { collaborationApi, type CollaborationTask, type TaskSubmission } from '../../api/collaboration';
import { SettingsDirtyContext } from '../../pages/settings-dirty';
import { TaskLifecycleDetail } from './TaskLifecycleDetail';
import { readTaskSubmissionDraft } from './task-submission-draft';

vi.mock('../../api/collaboration', () => ({ collaborationApi: { submissions: vi.fn(), submit: vi.fn() } }));
vi.mock('../../pages/task-files-client', () => ({ taskFilesKey: (projectId: string, taskId: string) => ['task-files', projectId, taskId], listTaskFiles: vi.fn(async () => []) }));
vi.mock('../../pages/TaskFileUploads', () => ({ TaskFileUploads: () => <p>成果文件</p> }));
vi.mock('../../pages/aiWorkflowSupport', () => ({ useVisibleJobPoller: () => ({ isSettled: false }) }));
vi.mock('./JobProgress', () => ({ JobProgress: () => null }));

const task = { taskId: 't1', title: '提交研究记录', revision: 3, assigneeId: 'u1', lifecycleState: 'in_progress', currentSubmissionId: null, unfinishedDependencyIds: [] } as unknown as CollaborationTask;
const submitted = { submissionId: 's1', evaluationJobId: null, evaluationError: null } as unknown as TaskSubmission;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(collaborationApi.submissions).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(collaborationApi.submit).mockResolvedValue(submitted);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function show(initial: { revision?: number; meId?: string; projectId?: string; taskId?: string; view?: 'submit' | 'settings' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const dirty = vi.fn();
  const onChanged = vi.fn(async () => {});
  const content = (options = initial) => {
    const meId = options.meId ?? 'u1';
    return <QueryClientProvider client={client}><SettingsDirtyContext.Provider value={dirty}><MemoryRouter><TaskLifecycleDetail view={options.view ?? 'submit'} projectId={options.projectId ?? 'p1'} task={{ ...task, revision: options.revision ?? 3, taskId: options.taskId ?? 't1', assigneeId: meId }} tasks={[]} owner={false} meId={meId} members={[]} onChanged={onChanged} /></MemoryRouter></SettingsDirtyContext.Provider></QueryClientProvider>;
  };
  return { ...render(content()), content, dirty };
}

it('persists each edit immediately, allows navigation and restores text after reopening', () => {
  const view = show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '尚未提交的研究记录' } });
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft).toMatchObject({ body: '尚未提交的研究记录', baseRevision: 3, conflict: false });
  expect(view.dirty).toHaveBeenLastCalledWith(expect.any(String), false);
  view.unmount();
  show();
  expect(screen.getByLabelText('成果说明')).toHaveValue('尚未提交的研究记录');
  expect(screen.getByText(/已恢复本机成果草稿/)).toBeInTheDocument();
});

it('preserves and locks a restored draft against newer task standards until explicitly reviewed', () => {
  const view = show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '按旧标准准备的文字' } });
  view.rerender(view.content({ revision: 4 }));
  expect(screen.getByRole('button', { name: '提交本轮成果' })).toBeDisabled();
  expect(screen.getByLabelText('成果说明')).toHaveValue('按旧标准准备的文字');
  view.unmount();
  show({ revision: 4 });
  expect(screen.getByRole('button', { name: '提交本轮成果' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '已核对标准，保留草稿继续提交' }));
  expect(screen.getByRole('button', { name: '提交本轮成果' })).toBeEnabled();
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft).toMatchObject({ body: '按旧标准准备的文字', baseRevision: 4, conflict: false });
});

it('restores explicit 409 locking even if text was cleared and the supplied task revision is unchanged', async () => {
  vi.mocked(collaborationApi.submit).mockRejectedValueOnce(new ApiError(409, { requestId: 'conflict', error: { code: 'REVISION_CONFLICT', message: '任务已变化', retryable: false } }));
  const view = show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '冲突后保留' } });
  fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
  await screen.findByRole('button', { name: '已核对标准，重新填写本轮提交' });
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '' } });
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft?.conflict).toBe(true);
  view.unmount();
  show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '新的文字仍须核对' } });
  expect(screen.getByRole('button', { name: '提交本轮成果' })).toBeDisabled();
});

it('remounts recovery state when the account, project or task changes without leaking text', () => {
  const view = show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '仅属于 u1 的 p1/t1' } });
  for (const scope of [{ meId: 'u2' }, { projectId: 'p2' }, { taskId: 't2' }]) {
    view.rerender(view.content(scope));
    expect(screen.getByLabelText('成果说明')).toHaveValue('');
  }
  view.rerender(view.content());
  expect(screen.getByLabelText('成果说明')).toHaveValue('仅属于 u1 的 p1/t1');
});

it('restores edits made inside task settings when returning to the submission view', async () => {
  const view = show({ view: 'settings' });
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  await screen.findByLabelText('成果说明');
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '任务设置中填写的成果' } });
  view.rerender(view.content({ view: 'submit' }));
  expect(screen.getByLabelText('成果说明')).toHaveValue('任务设置中填写的成果');
});

it('warns and guards closing when a local draft write fails', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  const view = show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '只有内存副本' } });
  expect(screen.getByRole('alert')).toHaveTextContent('浏览器无法保存本机成果草稿');
  expect(view.dirty).toHaveBeenLastCalledWith(expect.any(String), true);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
});

it('keeps a draft when submitting fails', async () => {
  vi.mocked(collaborationApi.submit).mockRejectedValueOnce(new Error('离线队列写入失败'));
  show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '失败后继续保留' } });
  fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
  await screen.findByText('离线队列写入失败');
  expect(screen.getByLabelText('成果说明')).toHaveValue('失败后继续保留');
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft?.body).toBe('失败后继续保留');
});

it.each([false, true])('clears only after server or durable queue success (offlinePending: %s)', async offlinePending => {
  let finish!: (value: TaskSubmission) => void;
  vi.mocked(collaborationApi.submit).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '等待提交完成' } });
  fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
  await waitFor(() => expect(collaborationApi.submit).toHaveBeenCalled());
  expect(screen.getByLabelText('成果说明')).toBeDisabled();
  expect(view.dirty).toHaveBeenLastCalledWith(expect.any(String), true);
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft?.body).toBe('等待提交完成');
  await act(async () => finish({ ...submitted, offlinePending } as TaskSubmission));
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft).toBeNull();
  expect(screen.getByLabelText('成果说明')).toHaveValue('');
});

it('reports failure to remove an already submitted draft', async () => {
  show();
  fireEvent.change(screen.getByLabelText('成果说明'), { target: { value: '服务端已完成' } });
  vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  fireEvent.click(screen.getByRole('button', { name: '提交本轮成果' }));
  await screen.findByText(/浏览器未能清理旧本机草稿/);
  expect(readTaskSubmissionDraft('u1', 'p1', 't1').draft?.body).toBe('服务端已完成');
});
