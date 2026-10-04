import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import { TaskAgentHandoff } from './TaskAgentHandoff';

const reads = vi.hoisted(() => ({ request: vi.fn(), list: vi.fn(), version: vi.fn(), submissions: vi.fn() }));
vi.mock('../api/simplification', () => ({ projectRequest: reads.request }));
vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(), api: { get: reads.version }, listAllItems: reads.list, projectPath: (id: string, path: string) => `/api/v1/projects/${id}${path}` }));
vi.mock('../api/collaboration', () => ({ collaborationApi: { submissions: reads.submissions } }));
vi.mock('../auth', () => ({ useSession: () => ({ data: null, isPending: false }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const task = { taskId: 't3', title: '制作报告', detail: '比较两个方案', criteria: '给出可复现证据', dueDate: '2026-10-10', revision: 3, effortHours: 4, lifecycleState: 'in_progress', dependsOnTaskIds: ['t2'], currentSubmissionId: null, citations: [{ sourceVersionId: 'src1', quote: '要求可复现', pageNumber: 2 }] } as unknown as CollaborationTask & { dueDate: string };
function setup() {
  reads.request.mockImplementation(async (_id, path) => path.endsWith('/agent-eligibility') ? { status: 'ready', taskRevision: task.revision, sourceHash: 'fixture', eligible: true, reason: null, jobId: 'j1' } : path === '/goal' ? { title: '项目目标', detail: '分析效率', revision: 2 } : { standard: { title: '正式标准', standardsVersionId: 'std1', version: 4, status: 'confirmed', requirements: [{ title: '可复现性', detail: '保存脚本', citations: [{ sourceVersionId: 'standard-source', quote: '评分需保存证据', pageNumber: 8 }] }], rubric: { weights: [{ label: '正确性', weight: 60 }], notes: '核验结果' } } });
  reads.list.mockResolvedValue([{ materialId: 'm1', title: '原始数据', currentVersionId: 'v1' }]);
  reads.version.mockResolvedValue({ versionId: 'v1', revision: 5, markdown: '固定正文', attachments: [{ fileId: 'f1', name: '数据.csv' }] });
  reads.submissions.mockResolvedValue({ items: [{ submissionId: 's1', round: 1, body: '前置结论', materialVersionIds: ['v1'] }] });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TaskAgentHandoff projectId="p1" task={task} tasks={[task, { ...task, taskId: 't2', title: '准备数据', dependsOnTaskIds: ['t1'] }, { ...task, taskId: 't1', title: '确认范围', dependsOnTaskIds: [], currentSubmissionId: 's1' }]}/></QueryClientProvider>);
}
describe('portable task handoff', () => {
  it('never fetches context for a directly opened unchecked dialog', async () => {
    reads.request.mockResolvedValue({ status: 'missing', taskRevision: task.revision, sourceHash: 'fixture', eligible: null, reason: null, jobId: null });
    render(<QueryClientProvider client={new QueryClient()}><TaskAgentHandoff projectId="p1" task={task} tasks={[]}/></QueryClientProvider>);
    await screen.findByText('AI 正在自动检查适用性，完成后可代实施。');
    expect(reads.request.mock.calls.every(call => String(call[1]).endsWith('/agent-eligibility'))).toBe(true);
    expect(reads.list).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('任务执行提示词')).toBeNull();
  });
  it('removes an already generated prompt when the task revision changes', async () => {
    const view = setup();
    await screen.findByLabelText('任务执行提示词');
    view.rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TaskAgentHandoff projectId="p1" task={{ ...task, revision: 4 }} tasks={[]}/></QueryClientProvider>);
    await screen.findByText('任务已更新，正在等待最新适用性判断。');
    expect(screen.queryByLabelText('任务执行提示词')).toBeNull();
    expect(screen.queryByRole('button', { name: '复制提示词' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下载提示词' })).toBeNull();
  });
  it('rejects direct handoff rendering when the server rejects a task without fetching or exporting context', async () => {
    reads.request.mockResolvedValue({ status: 'ready', taskRevision: task.revision, sourceHash: 'fixture', eligible: false, reason: '该任务需要真人参与或现场操作', jobId: 'j1' });
    render(<QueryClientProvider client={new QueryClient()}><TaskAgentHandoff projectId="p1" task={{ ...task, title: '开展实地调研' }} tasks={[]}/></QueryClientProvider>);
    expect(await screen.findByText('此任务暂不支持代实施。')).toBeInTheDocument();
    expect(screen.queryByText('该任务需要真人参与或现场操作')).toBeNull();
    expect(screen.queryByRole('button', { name: '复制提示词' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下载提示词' })).toBeNull();
    expect(reads.request.mock.calls.every(call => String(call[1]).endsWith('/agent-eligibility'))).toBe(true);
    expect(reads.list).not.toHaveBeenCalled();
  });
  it('includes standards, goal, all prerequisites, fixed material text, links and criteria; copies without writes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } }); setup();
    const prompt = (await screen.findByLabelText('任务执行提示词') as HTMLTextAreaElement).value;
    for (const fragment of ['分析效率', '正式标准', '2026-10-10', 'standard-source', '评分需保存证据', '保存脚本', '正确性', '给出可复现证据', '准备数据', '确认范围', '前置结论', '固定正文', '数据.csv', '/files/f1/content', '要求可复现']) expect(prompt).toContain(fragment);
    fireEvent.click(screen.getByRole('button', { name: '复制提示词' }));
    expect(await screen.findByText('提示词已复制，可粘贴给本地 Agent 执行。')).toBeInTheDocument();
    expect(reads.request).toHaveBeenCalledWith('p1', '/standards/current'); expect(reads.request).not.toHaveBeenCalledWith('p1', '/standards'); expect(prompt).toContain('生效标准'); expect(prompt).not.toContain('待确认'); expect(writeText).toHaveBeenCalledWith(prompt); expect(reads.submissions).toHaveBeenCalledWith('p1', 't1');
  });
  it('keeps the prompt selectable when clipboard access fails', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } }); setup();
    await screen.findByLabelText('任务执行提示词'); fireEvent.click(screen.getByRole('button', { name: '复制提示词' }));
    expect(await screen.findByText(/复制失败/)).toBeInTheDocument(); expect(screen.getByLabelText('任务执行提示词')).toBeInTheDocument(); expect(screen.queryByText(/已复制/)).toBeNull();
  });
  it('exports the fixed prerequisite submission version when it differs from the current material', async () => {
    setup();
    reads.submissions.mockResolvedValue({ items: [{ submissionId: 's1', round: 1, body: '旧版成果', materialVersionIds: ['old-v1'], materialVersions: [{ materialId: 'm1', versionId: 'old-v1', title: '原始数据', revision: 2 }] }] });
    reads.version.mockImplementation(async path => ({ versionId: path.endsWith('old-v1') ? 'old-v1' : 'v1', revision: path.endsWith('old-v1') ? 2 : 5, markdown: path.endsWith('old-v1') ? '验收当时的正文' : '当前正文', attachments: [] }));
    const prompt = (await screen.findByLabelText('任务执行提示词') as HTMLTextAreaElement).value;
    expect(prompt).toContain('验收当时的正文'); expect(prompt).toContain('当前正文'); expect(prompt).toContain('old-v1');
  });
  it('does not export a partial prompt after a material read failure', async () => {
    setup(); reads.version.mockRejectedValue(new Error('材料读取失败'));
    expect(await screen.findByText('材料读取失败')).toBeInTheDocument(); expect(screen.queryByLabelText('任务执行提示词')).toBeNull(); expect(screen.queryByRole('button', { name: '复制提示词' })).toBeNull();
  });
  it('creates a UTF-8 Markdown download and cleans up its object URL', async () => {
    setup(); await screen.findByLabelText('任务执行提示词');
    const create = vi.fn().mockReturnValue('blob:task'); const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: '下载提示词' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:task'), { timeout: 1500 });
    expect(create.mock.calls[0][0].type).toBe('text/markdown;charset=utf-8'); expect(click).toHaveBeenCalled(); expect(screen.getByText('提示词文件已生成。请将文件交给本地 Agent 执行。')).toBeInTheDocument();
    click.mockRestore();
  });
});
