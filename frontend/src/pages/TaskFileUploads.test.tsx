import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskFileUploads } from './TaskFileUploads';
import { projectRequest } from '../api/simplification';
import { uploadProjectFile } from './source-workflows';
import type { TaskFile } from './task-files-client';
import { api } from '../api/client';
vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(), api: { ... (await importOriginal<typeof import('../api/client')>()).api, get: vi.fn() } }));
vi.mock('../api/simplification', () => ({ projectRequest: vi.fn() }));
vi.mock('./source-workflows', () => ({ uploadProjectFile: vi.fn() }));
const request = vi.mocked(projectRequest), upload = vi.mocked(uploadProjectFile);
const file: TaskFile = { materialId: 'm', fileId: 'f', name: '报告.pdf', revision: 3, versionId: 'v', taskId: 't', lifecycleVersion: 2, archivedAt: null, materialArchivedAt: null, canManage: true };
const onBusy = vi.fn();
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function show(items: TaskFile[] = []) {
  request.mockImplementation(async (_project, _path, options) => options?.method ? file : { items });
  upload.mockResolvedValue('new-file');
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><TaskFileUploads projectId="p" taskId="t" disabled={false} onBusy={onBusy}/></QueryClientProvider>);
}
it('uploads bytes then registers the file automatically without a material picker', async () => {
  show(); await waitFor(() => expect(screen.getByLabelText('上传成果文件')).toBeEnabled());
  const selected = new File(['bytes'], '新文件.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('上传成果文件'), { target: { files: [selected] } });
  await waitFor(() => expect(request).toHaveBeenCalledWith('p', '/tasks/t/files', expect.objectContaining({ method: 'POST', body: { fileId: 'new-file' } })));
  expect(upload).toHaveBeenCalledWith('p', selected, expect.any(String), expect.any(Function));
  expect(screen.queryByLabelText(/绑定材料/)).toBeNull();
});
it('reuses successfully uploaded bytes when registration fails and is retried', async () => {
  show(); await waitFor(() => expect(screen.getByLabelText('上传成果文件')).toBeEnabled());
  let fail = true;
  request.mockImplementation(async (_project, _path, options) => { if (options?.method) { if (fail) throw new Error('入库失败'); return file; } return { items: [] }; });
  fireEvent.change(screen.getByLabelText('上传成果文件'), { target: { files: [new File(['bytes'], '新文件.pdf')] } });
  await screen.findByText('入库失败'); expect(onBusy).toHaveBeenLastCalledWith(true, '请重试或移除失败的待上传文件。');
  fail = false; fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByText('入库失败')).toBeNull());
  expect(upload).toHaveBeenCalledTimes(1);
  const writes = request.mock.calls.filter(([, , options]) => options?.method === 'POST');
  expect(writes).toHaveLength(2); expect(writes[0][2]?.idempotencyKey).toBe(writes[1][2]?.idempotencyKey);
});
it('replaces an existing file using the material revision and new immutable bytes', async () => {
  show([file]); await screen.findByRole('link', { name: '报告.pdf' });
  fireEvent.change(screen.getByLabelText('更新文件：报告.pdf'), { target: { files: [new File(['replacement'], '新版.pdf')] } });
  await waitFor(() => expect(request).toHaveBeenCalledWith('p', '/tasks/t/files/m', expect.objectContaining({ method: 'PUT', body: { fileId: 'new-file', expectedRevision: 3 } })));
});
it('recovers an upload whose completion response was lost without uploading again', async () => {
  show(); await waitFor(() => expect(screen.getByLabelText('上传成果文件')).toBeEnabled());
  upload.mockImplementationOnce(async (_project, _file, _key, initialized) => { initialized?.('confirmed-file'); throw new Error('上传响应丢失'); });
  vi.mocked(api.get).mockResolvedValue({ items: [{ fileId: 'confirmed-file', name: '已上传.pdf', status: 'available', sizeBytes: 10, createdAt: '2026-10-04', deletedAt: null, lifecycleVersion: 1, canDelete: true, sourceIds: [] }], nextCursor: null } as never);
  fireEvent.change(screen.getByLabelText('上传成果文件'), { target: { files: [new File(['bytes'], '已上传.pdf')] } });
  await screen.findByText('上传响应丢失'); fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('p', '/tasks/t/files', expect.objectContaining({ body: { fileId: 'confirmed-file' } })));
  expect(upload).toHaveBeenCalledTimes(1);
});
it('hides archived files by default and supports restoring material and file separately', async () => {
  show([{ ...file, archivedAt: '2026-10-04', materialArchivedAt: '2026-10-04' }]);
  await waitFor(() => expect(screen.getByRole('button', { name: '已归档（1）' })).toBeInTheDocument());
  expect(screen.queryByRole('link', { name: '报告.pdf' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '已归档（1）' }));
  expect(screen.queryByLabelText('更新文件：报告.pdf')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '撤销材料归档' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('p', '/materials/m/unarchive', { method: 'POST', body: { expectedRevision: 3 } }));
});
it('blocks submission with an explicit reason until a failed upload is removed', async () => {
  show(); await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false, ''));
  upload.mockRejectedValueOnce(new Error('上传失败'));
  fireEvent.change(screen.getByLabelText('上传成果文件'), { target: { files: [new File(['bytes'], '失败.pdf')] } });
  await screen.findByText('上传失败');
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true, '请重试或移除失败的待上传文件。'));
  fireEvent.click(screen.getByRole('button', { name: '移除待上传项' }));
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false, ''));
});
