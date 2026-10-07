import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useVisibleJobPoller } from './aiWorkflowSupport';
const get = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { get } }));
afterEach(() => { cleanup(); vi.useRealTimers(); get.mockReset(); });
it('stops at waiting_input and resumes the same job only after an explicit refresh', async () => {
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  get.mockResolvedValueOnce({ jobId: 'same-job', status: 'waiting_input' }).mockResolvedValueOnce({ jobId: 'same-job', status: 'running' }).mockResolvedValueOnce({ jobId: 'same-job', status: 'succeeded' });
  try {
    const { result, rerender } = renderHook(({ version }) => useVisibleJobPoller('same-job', version), { initialProps: { version: 0 } });
    await waitFor(() => expect(result.current.job?.status).toBe('waiting_input'));
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => rerender({ version: 1 }));
    expect(result.current.job?.status).toBe('running');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.job?.status).toBe('succeeded');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(get).toHaveBeenCalledTimes(3);
  } finally {
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});
it('follows the successor attempt and retains known completion during status refresh', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  get.mockResolvedValueOnce({ jobId: 'successor', status: 'running' }).mockResolvedValueOnce({ jobId: 'successor', status: 'succeeded' });
  vi.useFakeTimers();
  const { result } = renderHook(() => useVisibleJobPoller('original'));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.job?.jobId).toBe('successor');
  expect(result.current.jobId).toBe('original');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(get.mock.calls[1]?.[0]).toBe('/api/v1/jobs/successor');
  expect(result.current.job?.status).toBe('succeeded');
  let finish!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => result.current.refresh());
  expect(result.current.job?.status).toBe('succeeded');
  await act(async () => finish({ jobId: 'successor', status: 'succeeded' }));
});
it('keeps one polling timer when an explicit refresh arrives during an in-flight request', async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ jobId: 'job', status: 'running' });
  renderHook(() => useVisibleJobPoller('job'));
  await act(async () => { window.dispatchEvent(new Event('ai-job-refresh')); });
  await act(async () => finish({ jobId: 'job', status: 'running' }));
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(get).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(get).toHaveBeenCalledTimes(3);
});
it('pauses polling offline, retains known status, and reconnects to the same job', async () => {
  const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  get.mockResolvedValue({ jobId: 'job', status: 'running' });
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useVisibleJobPoller('job'));
    await act(async () => { await Promise.resolve(); }); expect(get).toHaveBeenCalledOnce();
    await act(async () => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); await vi.advanceTimersByTimeAsync(30_000); });
    expect(get).toHaveBeenCalledOnce(); expect(result.current.job?.status).toBe('running');
    await act(async () => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
    expect(get).toHaveBeenCalledTimes(2); expect(get.mock.calls[1][0]).toBe('/api/v1/jobs/job');
  } finally { if (originalOnline) Object.defineProperty(navigator, 'onLine', originalOnline); else Reflect.deleteProperty(navigator, 'onLine'); }
});
