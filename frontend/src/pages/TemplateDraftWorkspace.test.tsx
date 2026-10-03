import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemplateDraftWorkspace } from './TemplateDraftWorkspace';
import { SettingsEditGuard } from './SettingsEditGuard';
import { cancelPageDialog } from '../dialogs/dialog-service';
import type { TemplateDraft, TemplatePayload, TemplateTask } from '../api/project-templates';
import type { WizardGoal } from './project-wizard';
import { webcrypto } from 'node:crypto';
import { creationFileHash } from './project-creation-workflow';
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'owner', displayName: '负责人' }, isLoading: false }), useCapabilities: () => ({ data: { limits: { maxFileBytes: 10485760 }, features: { aiEnabled: true } } }) }));
const path = '/api/v1/creation-drafts/draft-template';
let stored: TemplateDraft;
let writes: Array<{ path: string; method: string; body: unknown }>;
let forceConflict = false;
let commitGate: Promise<void> | null = null;
beforeEach(() => {
  stored = { id: 'draft-template', status: 'active', revision: 1, payload: { name: '未命名项目', description: '', teamSize: 1, aiCollaborationEnabled: false, inviteUsernames: [], inviteLabels: [], brief: '', workspace: { templateId: 'blank', materials: [], standards: null } }, preview: null, previewRevision: null, previewState: 'none', clarification: null, previewError: null, files: [], removedFiles: [], projectId: null, updatedAt: '2026-10-02' };
  writes = []; forceConflict = false; commitGate = null; sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const current = new URL(String(url), 'http://localhost'); const method = init?.method ?? 'GET';
    if (method === 'GET') return Response.json({ requestId: 'read', data: structuredClone(stored) });
    const body = method === 'PUT' ? init?.body : JSON.parse(String(init?.body)); writes.push({ path: current.pathname, method, body });
    const expectedRevision = method === 'PUT' ? Number(current.searchParams.get('expectedRevision')) : (body as { expectedRevision?: number }).expectedRevision;
    if (forceConflict || expectedRevision !== stored.revision) return Response.json({ requestId: 'conflict', error: { code: 'VERSION_CONFLICT', message: '草稿已修改', retryable: false } }, { status: 409 });
    if (method === 'PATCH') { stored = { ...stored, revision: stored.revision + 1, payload: (body as { payload: TemplatePayload }).payload, previewState: 'invalid' }; }
    else if (current.pathname.endsWith('/preview')) { const preview = body as { goal: WizardGoal; tasks: TemplateTask[] }; const revision = stored.revision + 1; stored = { ...stored, revision, previewRevision: revision, previewState: 'ready', preview: { mode: 'manual', goal: preview.goal, tasks: preview.tasks } }; }
    else if (current.pathname.endsWith('/commit')) { stored = { ...stored, status: 'committed', projectId: 'created' }; if (commitGate) await commitGate; return Response.json({ requestId: 'commit', data: { projectId: 'created', invitations: [], usernameInvitations: stored.payload.inviteUsernames } }); }
    else if (method === 'PUT') { const file = init!.body as File; stored = { ...stored, revision: stored.revision + 1, previewState: 'invalid', files: [...stored.files, { id: current.pathname.split('/').at(-1)!, name: current.searchParams.get('name')!, sizeBytes: file.size, sha256: await creationFileHash(file), textReady: true, textError: null }] }; }
    else if (current.pathname.endsWith('/state')) { stored = { ...stored, revision: stored.revision + 1, status: (body as { status: 'active' | 'cancelled' }).status }; }
    return Response.json({ requestId: 'write', data: structuredClone(stored) });
  }));
});
afterEach(async () => { await act(async () => cancelPageDialog()); cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function show() {
  const router = createMemoryRouter([{ path: '/app/projects/new/template/:draftId', element: <SettingsEditGuard><TemplateDraftWorkspace /></SettingsEditGuard> }, { path: '/app/projects/new', element: <h1>创建方式选择</h1> }, { path: '/app/projects/created', element: <h1>正式项目</h1> }], { initialEntries: ['/app/projects/new/template/draft-template'] });
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, ...view };
}
async function tab(name: string) { fireEvent.click(within(screen.getByRole('navigation', { name: '模板预览分区' })).getByRole('button', { name })); }
async function loaded() { await screen.findByText('模板预览 · 未创建'); }
it('opens five editable draft areas with no operational tasks, grades or formal-project calls', async () => {
  show(); await loaded();
  expect(within(screen.getByRole('navigation', { name: '模板预览分区' })).getAllByRole('button').map(button => button.textContent)).toEqual(['概览', '任务', '资料', '评分', '团队']);
  await tab('任务'); expect(screen.getByText('尚无子任务')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '我来认领' })).toBeNull();
  await tab('资料'); expect(screen.getByText('尚无文档')).toBeInTheDocument();
  await tab('评分'); expect(screen.getByText('尚无项目标准')).toBeInTheDocument(); expect(screen.queryByText(/本轮总分/)).toBeNull();
  await tab('团队'); expect(screen.getByLabelText('创建后开启 AI 智能协作')).not.toBeChecked(); expect(screen.queryByRole('button', { name: '创建邀请码' })).toBeNull();
  expect(screen.getByText('用于团队规划，可在创建后继续邀请成员；不设置项目人数上限。')).toBeInTheDocument();
  expect(screen.getByLabelText(/^计划组员总人数（含负责人）/)).toHaveValue(1);
  expect(writes).toEqual([]);
});
it('saves private payload and keyed tasks, then recovers them on a fresh page without creating a project', async () => {
  const view = show(); await loaded(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '私有预览' } });
  await tab('任务'); fireEvent.click(screen.getByRole('button', { name: '添加子任务' }));
  fireEvent.change(screen.getByLabelText('子任务标题'), { target: { value: '整理依据' } }); fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '可追溯原文' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await screen.findByText('私有草稿已保存，尚未创建正式项目。');
  expect(writes.map(write => write.path)).toEqual([path, `${path}/preview`]); expect(stored.preview?.tasks[0]?.key).toBeTruthy();
  view.unmount(); show(); await loaded(); await tab('任务');
  expect(screen.getByLabelText('子任务标题')).toHaveValue('整理依据'); expect(screen.getByLabelText('验收标准')).toHaveValue('可追溯原文');
  expect(writes.some(write => write.path.endsWith('/commit') || write.path.startsWith('/api/v1/projects/'))).toBe(false);
});
it('creates authored goal, dependencies, documents and standards only at the final save', async () => {
  const { router } = show(); await loaded(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '完整预览' } });
  fireEvent.change(screen.getByLabelText(/^项目主目标（可选）/), { target: { value: '完成可复现交付' } });
  await tab('任务'); fireEvent.click(screen.getByRole('button', { name: '添加子任务' })); fireEvent.click(screen.getByRole('button', { name: '添加子任务' }));
  const titles = screen.getAllByLabelText('子任务标题'), criteria = screen.getAllByLabelText('验收标准');
  fireEvent.change(titles[0]!, { target: { value: '整理依据' } }); fireEvent.change(criteria[0]!, { target: { value: '完整正文' } });
  fireEvent.change(titles[1]!, { target: { value: '完成成果' } }); fireEvent.change(criteria[1]!, { target: { value: '可复现' } });
  fireEvent.click(within(screen.getAllByRole('group', { name: '前置子任务' })[1]!).getByLabelText('整理依据'));
  await tab('资料'); fireEvent.click(screen.getByRole('button', { name: '新建文档' })); fireEvent.change(screen.getByLabelText('文档标题'), { target: { value: '研究背景' } }); fireEvent.change(screen.getByLabelText('文档用途'), { target: { value: 'background' } }); fireEvent.change(screen.getByLabelText('文档正文（Markdown）'), { target: { value: '# 原始背景\n正文保留' } });
  await tab('评分'); fireEvent.click(screen.getByRole('button', { name: '添加项目标准' })); fireEvent.click(screen.getByRole('button', { name: '添加要求' })); fireEvent.change(screen.getByLabelText('要求标题'), { target: { value: '能够复现结果' } }); fireEvent.click(screen.getByLabelText('此要求参与评分'));
  await tab('团队'); fireEvent.change(screen.getByLabelText(/^拟邀请的登录用户名/), { target: { value: 'alice' } });
  expect(writes).toHaveLength(0); const save = screen.getByRole('button', { name: '保存并创建项目' }); fireEvent.click(save); fireEvent.click(save);
  await screen.findByRole('heading', { name: '正式项目' }); expect(router.state.location.pathname).toBe('/app/projects/created');
  expect(writes.map(write => write.path)).toEqual([path, `${path}/preview`, `${path}/commit`]);
  const payload = (writes[0]?.body as { payload: TemplatePayload }).payload; const preview = writes[1]?.body as { goal: WizardGoal; tasks: TemplateTask[] };
  expect(payload.workspace?.materials[0]).toMatchObject({ title: '研究背景', markdown: '# 原始背景\n正文保留', purpose: 'background' }); expect(payload.workspace?.standards?.weights[0]).toMatchObject({ label: '能够复现结果', weight: 100 });
  expect(preview.goal.title).toBe('完成可复现交付'); expect(preview.tasks).toHaveLength(2); expect(preview.tasks[1]?.dependsOn).toEqual([preview.tasks[0]?.key]);
});
it('retains all local inputs on a CAS conflict and prevents a premature formal commit', async () => {
  show(); await loaded(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '保留本地名称' } }); forceConflict = true;
  fireEvent.click(screen.getByRole('button', { name: '保存并创建项目' }));
  await screen.findByText(/当前所有输入保留/); expect(screen.getByLabelText('项目名称')).toHaveValue('保留本地名称'); expect(screen.getByRole('button', { name: '保存并创建项目' })).toBeDisabled();
  expect(writes.map(write => write.path)).toEqual([path]);
});
it('keeps unsaved inputs when leaving the draft is canceled', async () => {
  const { router } = show(); await loaded(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '保留草稿编辑' } });
  fireEvent.click(screen.getByRole('link', { name: '新建项目' })); const dialog = await screen.findByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(router.state.location.pathname).toContain('/template/'); expect(screen.getByLabelText('项目名称')).toHaveValue('保留草稿编辑'); expect(writes).toHaveLength(0);
});
it('uploads only to the private draft and retains authored tasks when rebuilding its preview', async () => {
  show(); await loaded(); await tab('任务'); fireEvent.click(screen.getByRole('button', { name: '添加子任务' })); fireEvent.change(screen.getByLabelText('子任务标题'), { target: { value: '上传后保留任务' } }); fireEvent.change(screen.getByLabelText('验收标准'), { target: { value: '文件与目标可核对' } });
  await tab('资料'); fireEvent.change(screen.getByLabelText(/^导入文件（可选）/), { target: { files: [new File(['real text'], 'source.txt', { type: 'text/plain' })] } });
  await screen.findByText(/文件已暂存到私有草稿/); await tab('任务'); expect(screen.getByLabelText('子任务标题')).toHaveValue('上传后保留任务');
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' })); await screen.findByText('私有草稿已保存，尚未创建正式项目。');
  expect(writes[0]?.method).toBe('PUT'); expect(writes[0]?.path).toMatch(/^\/api\/v1\/creation-drafts\/draft-template\/files\//); expect(stored.preview?.tasks[0]?.title).toBe('上传后保留任务'); expect(writes.some(write => write.path.startsWith('/api/v1/projects/') || write.path.endsWith('/commit'))).toBe(false);
});
it('allows an untouched blank template to create a minimal project with no seeded content', async () => {
  show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '保存并创建项目' })); await screen.findByRole('heading', { name: '正式项目' }); expect(stored.preview?.tasks).toEqual([]); expect(stored.payload.workspace).toEqual({ templateId: 'blank', materials: [], standards: null }); expect(writes.filter(write => write.path.endsWith('/commit'))).toHaveLength(1);
});

it('does not redirect a new page when an earlier final commit response arrives late', async () => {
  let release: (() => void) | undefined; commitGate = new Promise<void>(resolve => { release = resolve; });
  const { router } = show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: '保存并创建项目' }));
  await waitFor(() => expect(writes.some(write => write.path.endsWith('/commit'))).toBe(true));
  fireEvent.click(screen.getByRole('link', { name: '新建项目' })); await screen.findByRole('heading', { name: '创建方式选择' });
  await act(async () => { release?.(); });
  expect(router.state.location.pathname).toBe('/app/projects/new'); expect(screen.queryByRole('heading', { name: '正式项目' })).toBeNull();
});
