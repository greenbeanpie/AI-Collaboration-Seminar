import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { TaskSettings } from './TaskSettings';
import { collaborationApi, type CollaborationTask } from '../api/collaboration';
import { projectRequest } from '../api/simplification';
import { ApiError } from '../api/client';

vi.mock('../api/collaboration', () => ({ collaborationApi: { updateTask: vi.fn(), assign: vi.fn(), claim: vi.fn() } }));
vi.mock('../api/simplification', () => ({ projectRequest: vi.fn() }));
const task = { taskId: 't1', title: '任务甲', detail: '说明', criteria: '标准', effortHours: 2, assigneeId: 'm1', revision: 3, dependsOnTaskIds: [], lifecycleState: 'in_progress' } as unknown as CollaborationTask;
const changed = vi.fn(async () => {});
function Fixture({ current = task }: { current?: CollaborationTask }) {
  const guard = useRef<(() => Promise<boolean>) | null>(null);
  return <><button onClick={async () => { if (await guard.current?.()) changed(); }}>关闭窗口</button><TaskSettings projectId="p1" task={current} tasks={[current, { ...task, taskId: 't2', title: '前置乙' }, { ...task, taskId: 't3', title: '前置丙' }]} graphRevision={9} canManage meId="m1" members={[{ userId: 'm1', displayName: '甲' }, { userId: 'm2', displayName: '乙' }]} onChanged={changed} closeGuard={guard} stateLabel="进行中" statusContent={<p>现有状态操作</p>}/></>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
function setup() {
  vi.useFakeTimers();
  vi.mocked(collaborationApi.updateTask).mockImplementation(async (_id, current, fields) => ({ ...current, ...fields, revision: current.revision + 1 }));
  vi.mocked(collaborationApi.assign).mockImplementation(async (_id, current, assigneeId) => ({ ...current, assigneeId, revision: current.revision + 1 }));
  vi.mocked(projectRequest).mockImplementation(async (_id, path) => path.endsWith('/dependencies') ? { graphRevision: 10 } : task);
  render(<Fixture/>);
  fireEvent.click(screen.getByRole('button', { name: '修改任务内容' }));
}
const idle = async (ms = 3000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
describe('task settings autosave', () => {
  it('debounces changes for three seconds and never writes unchanged values', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '新名称' } });
    await idle(2999); expect(collaborationApi.updateTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '最终名称' } });
    await idle(); expect(collaborationApi.updateTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(collaborationApi.updateTask).mock.calls[0][2].title).toBe('最终名称');
    await idle(6000); expect(collaborationApi.updateTask).toHaveBeenCalledTimes(1);
  });
  it('flushes valid edits on close and waits for the response', async () => {
    setup(); let finish!: (value: CollaborationTask) => void;
    vi.mocked(collaborationApi.updateTask).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '关闭前保存' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => finish({ ...task, title: '关闭前保存', revision: 4 }));
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('flushes on leaving the settings region', async () => {
    setup(); fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '失焦保存' } });
    fireEvent.blur(screen.getByLabelText('任务名称'), { relatedTarget: null });
    await idle(0); expect(collaborationApi.updateTask).toHaveBeenCalledTimes(1);
  });
  it('keeps invalid or failed drafts and blocks closing', async () => {
    setup(); fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' })); await idle(0);
    expect(collaborationApi.updateTask).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('验收标准')).toHaveValue('');
    vi.mocked(collaborationApi.updateTask).mockRejectedValue(new Error('网络失败'));
    fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '有效草稿' } });
    await idle(); expect(screen.getByRole('status')).toHaveTextContent('网络失败');
    expect(screen.getByLabelText('验收标准')).toHaveValue('有效草稿');
  });
  it('serializes content and assignment using the returned revision and requires a reason', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: '修改分工' }));
    fireEvent.change(screen.getByLabelText('任务执行人'), { target: { value: 'm2' } });
    await idle(); expect(collaborationApi.assign).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '并行草稿' } });
    fireEvent.change(screen.getByLabelText('分工理由'), { target: { value: '由乙接手' } });
    await idle(); expect(collaborationApi.assign).toHaveBeenCalledWith('p1', expect.objectContaining({ revision: 4 }), 'm2', '由乙接手');
  });
  it('rebases disjoint changes after 409, preserving the latest untouched field', async () => {
    setup();
    vi.mocked(collaborationApi.updateTask).mockRejectedValueOnce(new ApiError(409, { requestId: 'r', error: { code: 'INVALID_STATE', message: '冲突', retryable: false } }));
    vi.mocked(projectRequest).mockImplementation(async (_id, path) => path === '/goal' ? { graphRevision: 10 } : { ...task, detail: '他人的说明', revision: 4 });
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '我的名称' } });
    await idle(); expect(collaborationApi.updateTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(collaborationApi.updateTask).mock.calls[1][2]).toMatchObject({ title: '我的名称', detail: '他人的说明' });
  });
  it('stops for a same-field conflict and supports choosing server content', async () => {
    setup();
    vi.mocked(collaborationApi.updateTask).mockRejectedValueOnce(new ApiError(409, { requestId: 'r', error: { code: 'INVALID_STATE', message: '冲突', retryable: false } }));
    vi.mocked(projectRequest).mockImplementation(async (_id, path) => path === '/goal' ? { graphRevision: 10 } : { ...task, title: '他人的名称', revision: 4 });
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '我的名称' } });
    await idle(); expect(collaborationApi.updateTask).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('任务名称')).toHaveValue('我的名称');
    fireEvent.click(screen.getByRole('button', { name: '使用最新内容' }));
    expect(screen.getByLabelText('任务名称')).toHaveValue('他人的名称');
    await idle(); expect(collaborationApi.updateTask).toHaveBeenCalledTimes(1);
  });
  it('puts status operations in a separate window and dependencies in a searchable page', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: '更新' })); await idle(0);
    expect(screen.getByRole('dialog', { name: '更新任务状态·任务甲' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '修改前置任务' }));
    expect(screen.getAllByRole('checkbox').map(item => item.parentElement?.textContent)).toEqual(['前置乙', '前置丙']);
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '丙' } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
