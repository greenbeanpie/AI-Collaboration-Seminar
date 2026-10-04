import { createHash, webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyCreateProjectPage } from './LegacyCreateProjectPage';
import { cancelPageDialog } from '../dialogs/dialog-service';
import { newCreationFile, readCreationDraft, writeCreationDraft, type CreationDraft } from './project-creation-workflow';

const project = { id: 'p', name: '测试项目', description: '', deadlineDate: null, deadlinePrecision: 'unknown', status: 'active', aiBudgetUsd: null, revision: 1, myRole: 'owner', createdAt: '2026-10-01', updatedAt: '2026-10-01' };
const user = { id: 'alice', username: 'alice', displayName: 'Alice', email: null, isAdmin: false, role: 'user' };
const capability = { features: { aiEnabled: false }, limits: { maxFileBytes: 1024 } };
const response = (data: unknown) => Response.json({ data, requestId: 'fixture' });
const failure = (code: string, status = 500) => Response.json({ error: { code, message: 'Fixture failure', retryable: false }, requestId: 'fixture' }, { status });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup(accountId = user.id) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['session'], { ...user, id: accountId }); client.setQueryData(['capabilities'], capability);
  const router = createMemoryRouter([
    { path: '/app/projects/new', element: <LegacyCreateProjectPage /> },
    { path: '/app', element: <div>项目列表目的地</div> },
    { path: '/app/projects/:projectId', element: <div>已有项目目的地</div> },
    { path: '/app/projects/:projectId/sources', element: <div>来源目的地</div> },
  ], { initialEntries: ['/app/projects/new'] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, client, router };
}
function fill(aiEnabled = false) { fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '测试项目' } }); const checkbox = screen.getByRole('checkbox', {name:/AI 智能协作/}) as HTMLInputElement; if (checkbox.checked !== aiEnabled) fireEvent.click(checkbox); }
function select(files: File[], recovery = false) {
  fireEvent.change(screen.getByLabelText(recovery ? /重新选择未完成的原文件/ : /项目文件（可选）/), { target: { files } });
}
function submit() { fireEvent.submit(screen.getByRole('form', { name: '新建项目' })); }
const original = (name: string, text = name) => new File([text], name, { type: 'text/plain', lastModified: 1 });
const pathOf = (url: RequestInfo | URL) => String(url);
function fixtureFetch(extra?: (url: string, init?: RequestInit) => Promise<Response> | Response | undefined) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = pathOf(input); const custom = extra?.(url, init); if (custom) return custom;
    if (url === '/api/v1/projects' && init?.method === 'POST') return response(project);
    if (url === '/api/v1/projects/p' && (init?.method ?? 'GET') === 'GET') return response(project);
    if (url === '/api/v1/projects/p/files') {
      const body = JSON.parse(String(init?.body)) as { fileName: string };
      return response({ fileId: body.fileName, upload: { method: 'PUT', url: `/api/v1/projects/p/files/${encodeURIComponent(body.fileName)}/content` } });
    }
    if (url.endsWith('/content') && init?.method === 'PUT') {
      const name = decodeURIComponent(url.split('/').at(-2)!);
      return response({ fileId: name, sizeBytes: name.length, sha256: hash(name), mimeDetected: 'text/plain' });
    }
    if (url === '/api/v1/projects/p/sources') {
      const body = JSON.parse(String(init?.body)) as { fileId: string };
      return response({ sourceId: `s-${body.fileId}`, sourceVersionId: `v-${body.fileId}` });
    }
    throw new Error(`Unexpected fixture route ${init?.method ?? 'GET'} ${url}`);
  });
}
const writes = (fetch: ReturnType<typeof fixtureFetch>, suffix: string, method = 'POST') => fetch.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === method);
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto); });
afterEach(async () => { await act(async () => { cancelPageDialog(); }); cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('project creation', () => {
  it('defaults AI on and suppresses repeated submits before the first response', async () => {
    const pending = deferred<Response>(); const fetch = fixtureFetch((url, init) => url === '/api/v1/projects' && init?.method === 'POST' ? pending.promise : undefined);
    vi.stubGlobal('fetch', fetch); setup(); fill(true);
    expect(screen.getByRole('checkbox', { name: /AI 智能协作/ })).toBeChecked();
    expect(fetch).not.toHaveBeenCalled(); submit(); submit();
    expect(writes(fetch, '/projects')).toHaveLength(1);
    expect(JSON.parse(String(writes(fetch, '/projects')[0][1]?.body))).toMatchObject({ aiCollaborationEnabled: true, planningMode:'automatic',assignmentMode:'automatic',evaluationMode:'automatic',progressionMode:'automatic' });
    expect(new Headers(writes(fetch, '/projects')[0][1]?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(screen.getByLabelText('项目名称')).toBeDisabled();
    await act(async () => pending.resolve(response(project))); await screen.findByText('已有项目目的地');
    expect(readCreationDraft(user.id)).toBeNull();
  });

  it('saves explicit AI opt-in without parsing files or calling a model', async () => {
    const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch); setup(); fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /AI 智能协作/ }));
    expect(screen.getByText(/系统 AI 当前未启用/)).toBeInTheDocument();
    expect(screen.getByText(/上传只保存原文件并建立来源/)).toBeInTheDocument(); submit();
    await screen.findByText('已有项目目的地');
    expect(JSON.parse(String(writes(fetch, '/projects')[0][1]?.body))).toMatchObject({ aiCollaborationEnabled: true });
    expect(fetch.mock.calls).toHaveLength(1);
  });

  it('reuses the frozen intent and body after a lost creation response', async () => {
    let attempt = 0;
    const fetch = fixtureFetch((url, init) => { if (url === '/api/v1/projects' && init?.method === 'POST' && ++attempt === 1) return Promise.reject(new TypeError('lost response')); });
    vi.stubGlobal('fetch', fetch); setup(); fill(); submit();
    await screen.findByText(/暂时无法连接服务/);
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '不能成为另一个项目' } });
    fireEvent.click(screen.getByRole('button', { name: '用原请求重试确认创建' }));
    await screen.findByText('已有项目目的地'); const calls = writes(fetch, '/projects');
    expect(calls).toHaveLength(2); expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(new Headers(calls[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(calls[1][1]?.headers).get('Idempotency-Key'));
  });

  it('keeps an AI-enabled file completion visible with grounded next steps and no automatic parsing', async () => {
    const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch); setup(); fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /AI 智能协作/ })); select([original('one.txt')]); submit();
    const next = await screen.findByRole('region', { name: 'AI 协作资料下一步' });
    await waitFor(() => expect(screen.getByRole('button', { name: '文件已保存' })).toBeDisabled());
    expect(next).toHaveTextContent('AI 协作仍待正文读取');
    expect(within(next).getByRole('link', { name: '选择来源并准备协作任务' })).toHaveAttribute('href', '/app/projects/p/tasks');
    expect(within(next).getByRole('link', { name: '查看通知与来源' })).toHaveAttribute('href', '/app/projects/p/sources');
    expect(fetch.mock.calls.some(([url]) => /parse|jobs|ai\//.test(String(url)))).toBe(false); expect(readCreationDraft(user.id)).toBeNull();
    submit(); expect(writes(fetch, '/projects')).toHaveLength(1); expect(writes(fetch, '/sources')).toHaveLength(1);
  });

  it('shows the existing project and retries only failed files', async () => {
    let broken = true;
    const fetch = fixtureFetch((url, init) => {
      if (url.endsWith('/files') && JSON.parse(String(init?.body)).fileName === 'two.txt' && broken) return failure('TEST_INIT_ERROR');
    });
    vi.stubGlobal('fetch', fetch); setup(); fill(); select([original('one.txt'), original('two.txt')]); submit();
    await screen.findByText('Fixture failure'); await waitFor(() => expect(screen.getByRole('button', { name: '重试未完成文件' })).toBeEnabled());
    expect(screen.getByRole('region', { name: '已创建项目' })).toHaveTextContent('测试项目');
    expect(screen.getByRole('list', { name: '文件上传进度' })).toHaveTextContent('已保存原文件并建立来源');
    broken = false; fireEvent.click(screen.getByRole('button', { name: '重试未完成文件' })); await screen.findByText('来源目的地');
    expect(writes(fetch, '/projects')).toHaveLength(1);
    expect(writes(fetch, '/files')).toHaveLength(3);
    expect(writes(fetch, '/one.txt/content', 'PUT')).toHaveLength(1);
    expect(writes(fetch, '/sources')).toHaveLength(2);
    expect(fetch.mock.calls.some(([url]) => /parse|jobs|ai\//.test(String(url)))).toBe(false);
  });

  it('retries a lost source response with the same key and no second upload', async () => {
    let broken = true;
    const fetch = fixtureFetch((url, init) => { if (url.endsWith('/sources') && init?.method === 'POST' && broken) return Promise.reject(new TypeError('lost source response')); });
    vi.stubGlobal('fetch', fetch); setup(); fill(); select([original('one.txt')]); submit();
    await screen.findByText(/无法连接服务/); await waitFor(() => expect(screen.getByRole('button', { name: '重试未完成文件' })).toBeEnabled());
    const saved = readCreationDraft(user.id)!; expect(saved.files[0]).toMatchObject({ fileId: 'one.txt', uploadConfirmed: true });
    broken = false; fireEvent.click(screen.getByRole('button', { name: '重试未完成文件' })); await screen.findByText('来源目的地');
    const sources = writes(fetch, '/sources'); expect(sources).toHaveLength(2);
    expect(new Headers(sources[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(sources[1][1]?.headers).get('Idempotency-Key'));
    expect(writes(fetch, '/one.txt/content', 'PUT')).toHaveLength(1);
  });

  it('stops after an in-flight creation and offers the real existing project without deleting it', async () => {
    const pending = deferred<Response>(); const fetch = fixtureFetch((url, init) => url === '/api/v1/projects' && init?.method === 'POST' ? pending.promise : undefined);
    vi.stubGlobal('fetch', fetch); setup(); fill(); select([original('one.txt')]); submit();
    fireEvent.click(screen.getByRole('button', { name: '停止后续操作' }));
    expect(screen.getByText(/已请求停止后续操作/)).toBeInTheDocument();
    await act(async () => pending.resolve(response(project)));
    await screen.findByRole('region', { name: '已创建项目' }); await waitFor(() => expect(screen.getByRole('button', { name: '保留进度并进入项目' })).toBeEnabled());
    expect(readCreationDraft(user.id)?.project?.id).toBe('p'); expect(writes(fetch, '/files')).toHaveLength(0);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH' || init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保留进度并进入项目' })); await screen.findByText('已有项目目的地');
    expect(writes(fetch, '/projects')).toHaveLength(1);
  });

  it('stops between upload and source creation and resumes without uploading the confirmed file again', async () => {
    const pending = deferred<Response>(); let firstPut = true;
    const fetch = fixtureFetch((url, init) => {
      if (url.endsWith('/one.txt/content') && init?.method === 'PUT' && firstPut) { firstPut = false; return pending.promise; }
    });
    vi.stubGlobal('fetch', fetch); setup(); fill(); select([original('one.txt'), original('two.txt')]); submit();
    await waitFor(() => expect(writes(fetch, '/one.txt/content', 'PUT')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '停止后续操作' }));
    await act(async () => pending.resolve(response({ fileId: 'one.txt', sizeBytes: 7, sha256: hash('one.txt'), mimeDetected: 'text/plain' })));
    await waitFor(() => expect(screen.getByRole('button', { name: '重试未完成文件' })).toBeEnabled());
    expect(writes(fetch, '/files')).toHaveLength(1); expect(writes(fetch, '/sources')).toHaveLength(0);
    expect(screen.getByRole('list', { name: '文件上传进度' })).toHaveTextContent('原文件已上传，来源尚未确认');
    fireEvent.click(screen.getByRole('button', { name: '重试未完成文件' })); await screen.findByText('来源目的地');
    expect(writes(fetch, '/one.txt/content', 'PUT')).toHaveLength(1); expect(writes(fetch, '/sources')).toHaveLength(2);
  });

  it('restores a confirmed upload after refresh and finishes source creation without needing file bytes', async () => {
    const record = { ...newCreationFile(original('one.txt')), fileId: 'one.txt', uploadAttempted: true, uploadConfirmed: true, status: 'failed' as const };
    const saved: CreationDraft = { version: 1, userId: user.id, createKey: 'same-project-key', createAttempted: true, payload: { name: project.name, description: '', deadlinePrecision: 'unknown', aiCollaborationEnabled: false }, project: { id: 'p', name: project.name, revision: 1, status: 'active' }, files: [record], interrupted: true };
    writeCreationDraft(saved); const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch); setup();
    expect(screen.getByText(/本次创建或上传已中断/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '重试未完成文件' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '重试未完成文件' })); await screen.findByText('来源目的地');
    expect(writes(fetch, '/projects')).toHaveLength(0); expect(writes(fetch, '/files')).toHaveLength(0); expect(writes(fetch, '/one.txt/content', 'PUT')).toHaveLength(0);
    expect(new Headers(writes(fetch, '/sources')[0][1]?.headers).get('Idempotency-Key')).toBe(record.sourceKey);
  });

  it('allows explicitly skipping incomplete files without archiving the project or blocking another new project', async () => {
    const saved: CreationDraft = { version: 1, userId: user.id, createKey: 'same-project-key', createAttempted: true, payload: { name: project.name, description: '', deadlinePrecision: 'unknown', aiCollaborationEnabled: false }, project: { id: 'p', name: project.name, revision: 1, status: 'active' }, files: [newCreationFile(original('one.txt'))], interrupted: true };
    writeCreationDraft(saved); const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch); const view = setup();
    expect(screen.queryByText(/仅结束本页的上传恢复进度/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '跳过未完成文件并进入项目' })); await screen.findByText('已有项目目的地');
    expect(readCreationDraft(user.id)).toBeNull(); expect(fetch.mock.calls.some(([, init]) => ['POST', 'PATCH', 'DELETE'].includes(init?.method ?? 'GET'))).toBe(false);
    view.unmount(); setup(); expect(screen.getByLabelText('项目名称')).toHaveValue('');
  });

  it('requires reselection after refresh and keeps recovery isolated to the current account', async () => {
    const record = newCreationFile(original('one.txt'));
    const saved: CreationDraft = { version: 1, userId: user.id, createKey: 'same-project-key', createAttempted: true, payload: { name: project.name, description: '', deadlinePrecision: 'unknown', aiCollaborationEnabled: false }, project: { id: 'p', name: project.name, revision: 1, status: 'active' }, files: [record], interrupted: true };
    writeCreationDraft(saved); const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch); const view = setup();
    expect(screen.getByText(/刷新后原文件不在浏览器内存中/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '重试未完成文件' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '重试未完成文件' })); await screen.findByText(/请重新选择同一原文件/);
    expect(writes(fetch, '/files')).toHaveLength(0); select([original('one.txt')], true);
    fireEvent.click(screen.getByRole('button', { name: '重试未完成文件' })); await screen.findByText('来源目的地');
    expect(writes(fetch, '/projects')).toHaveLength(0); view.unmount(); writeCreationDraft(saved); setup('bob');
    expect(screen.getByLabelText('项目名称')).toHaveValue(''); expect(screen.queryByRole('region', { name: '已创建项目' })).toBeNull();
  });

  it('validates the 10-file count, capability byte limit, extensions, and empty files before creating', () => {
    const fetch = fixtureFetch(); vi.stubGlobal('fetch', fetch); setup(); fill();
    select(Array.from({ length: 11 }, (_, index) => original(`${index}.txt`))); expect(screen.getByRole('alert')).toHaveTextContent('最多选择 10 个文件');
    select([original('bad.exe')]); expect(screen.getByRole('alert')).toHaveTextContent('不支持');
    select([original('big.txt', 'x'.repeat(1025))]); expect(screen.getByRole('alert')).toHaveTextContent('超过单文件');
    select([original('empty.txt', '')]); expect(screen.getByRole('alert')).toHaveTextContent('为空文件');
    expect(fetch).not.toHaveBeenCalled(); expect(screen.queryByRole('list', { name: '文件上传进度' })).toBeNull();
  });

  it('archives only on the explicitly labeled action with CAS and never retries a conflict automatically', async () => {
    const saved: CreationDraft = { version: 1, userId: user.id, createKey: 'same-project-key', createAttempted: true, payload: { name: project.name, description: '', deadlinePrecision: 'unknown', aiCollaborationEnabled: false }, project: { id: 'p', name: project.name, revision: 1, status: 'active' }, files: [], interrupted: true };
    writeCreationDraft(saved);
    const fetch = fixtureFetch((url, init) => url === '/api/v1/projects/p' && init?.method === 'PATCH' ? failure('VERSION_CONFLICT', 409) : undefined);
    vi.stubGlobal('fetch', fetch); setup(); await waitFor(() => expect(screen.getByRole('button', { name: '归档此项目草稿' })).toBeEnabled());
    expect(writes(fetch, '/projects/p', 'PATCH')).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: '归档此项目草稿' }));
    await screen.findByText(/归档未执行/); expect(screen.getByRole('button', { name: '归档此项目草稿' })).toBeDisabled();
    const patches = writes(fetch, '/projects/p', 'PATCH'); expect(patches).toHaveLength(1); expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ expectedRevision: 1, status: 'archived' });
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false); expect(readCreationDraft(user.id)?.project?.id).toBe('p');
  });

  it('warns on navigation while pending and persists the accepted project after leaving', async () => {
    const pending = deferred<Response>(); const fetch = fixtureFetch((url, init) => url === '/api/v1/projects' && init?.method === 'POST' ? pending.promise : undefined);
    vi.stubGlobal('fetch', fetch); setup(); fill(); select([original('one.txt')]); submit();
    fireEvent.click(screen.getByRole('link', { name: '返回项目列表' })); const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('已发出的请求可能已成功');
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: '确定' })));
    await screen.findByText('项目列表目的地'); await act(async () => pending.resolve(response(project)));
    await waitFor(() => expect(readCreationDraft(user.id)?.project?.id).toBe('p'));
    expect(readCreationDraft(user.id)?.interrupted).toBe(true); expect(writes(fetch, '/files')).toHaveLength(0);
  });
});
