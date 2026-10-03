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
