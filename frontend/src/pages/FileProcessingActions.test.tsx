import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { FileProcessingActions } from './FileProcessingActions';
import { getFileProcessing, prepareFileScanPages, startFileProcessing, type FileProcessingState } from './file-processing-client';
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: true }, limits: {} } }) }));
vi.mock('./file-processing-client', () => ({ fileProcessingKey: (projectId: string, fileId: string) => ['fileProcessing', projectId, fileId], getFileProcessing: vi.fn(), startFileProcessing: vi.fn(), prepareFileScanPages: vi.fn() }));
const state: FileProcessingState = { fileId: 'f', lifecycleVersion: 4, sourceId: 's', sourceVersionId: 'v', jobId: null, textStatus: 'pending', summaryStatus: 'pending', requirementsStatus: 'skipped', error: null, materialIds: [], textAvailable: false, canProcess: true, needsImages: 0 };
function show(value = state, disabled = false) {
  vi.mocked(getFileProcessing).mockResolvedValue(value);
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><FileProcessingActions projectId="p" fileId="f" disabled={disabled} /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });
afterEach(cleanup);
describe('visible file processing actions', () => {
  it('offers extraction outside details and submits the current lifecycle version', async () => {
    show();
    const button = await screen.findByRole('button', { name: '提取正文' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button.closest('details')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(startFileProcessing).toHaveBeenCalledWith('p', 'f', 4, false));
    expect(screen.getByRole('link', { name: '查看正文与处理记录' })).toHaveAttribute('href', '/app/projects/p/data?resourceType=source&resourceId=s');
  });
  it('retries failed stages without discarding completed text', async () => {
    show({ ...state, textAvailable: true, textStatus: 'ready', summaryStatus: 'failed', error: '总结失败' });
    fireEvent.click(await screen.findByRole('button', { name: '重试处理' }));
    await waitFor(() => expect(startFileProcessing).toHaveBeenCalledWith('p', 'f', 4, true));
    expect(screen.getByText(/正文提取：已完成/)).toBeInTheDocument();
  });
  it('keeps active processing disabled', async () => {
    show({ ...state, textStatus: 'processing' });
    expect(await screen.findByRole('button', { name: '后台处理中' })).toBeDisabled();
  });
  it('offers manual page preparation for scans', async () => {
    show({ ...state, textStatus: 'waiting_input', needsImages: 2 });
    fireEvent.click(await screen.findByRole('button', { name: '准备扫描页并识别' }));
    await waitFor(() => expect(prepareFileScanPages).toHaveBeenCalledWith('p', expect.objectContaining({ needsImages: 2 }), {}, expect.any(Function)));
  });
  it('blocks processing without permission and when a dirty material disables it', async () => {
    show({ ...state, canProcess: false }, true);
    expect(await screen.findByRole('button', { name: '提取正文' })).toBeDisabled();
  });
  it('does not read or enqueue processing while offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    show();
    expect(screen.getByRole('button', { name: '提取正文' })).toBeDisabled();
    expect(getFileProcessing).not.toHaveBeenCalled();
    expect(startFileProcessing).not.toHaveBeenCalled();
  });
});
