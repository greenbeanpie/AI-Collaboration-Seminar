import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobAiActivity } from './JobAiActivity';
import { retryBackendJob, useVisibleJobPoller } from './aiWorkflowSupport';
import type { Job } from '../api/types';

vi.mock('./aiWorkflowSupport', () => ({ retryBackendJob: vi.fn(), useVisibleJobPoller: vi.fn() }));
vi.mock('../components/AiActivityStatus', () => ({ AiActivityStatus: ({ onResume, onRefresh, resuming, jobId }: {onResume?: () => void; onRefresh: () => void; resuming: boolean; jobId?: string}) => <div><span>{jobId}</span><button disabled={resuming} onClick={onResume}>继续</button><button onClick={onRefresh}>重读</button></div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const stopped = { jobId: 'old', job: { jobId: 'old', status: 'failed' } as Job, error: null, loading: false, isSettled: true, refresh: vi.fn() };
describe('job activity business entry integration', () => {
  it('locks repeated resume clicks and follows the server returned attempt', async () => {
    vi.mocked(useVisibleJobPoller).mockReturnValue(stopped);
    let finish!: (id: string) => void;
    vi.mocked(retryBackendJob).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onResumed = vi.fn();
    render(<JobAiActivity projectId="p" jobId="old" onResumed={onResumed} />);
    fireEvent.click(screen.getByText('继续')); fireEvent.click(screen.getByText('继续'));
    expect(retryBackendJob).toHaveBeenCalledExactlyOnceWith('p', 'old');
    expect(screen.getByText('继续')).toBeDisabled();
    finish('resumed');
    await waitFor(() => expect(useVisibleJobPoller).toHaveBeenLastCalledWith('resumed', 0));
    expect(onResumed).toHaveBeenCalledWith('resumed');
  });
  it('retries reading state without retrying AI and notifies a settled business once', () => {
    vi.mocked(useVisibleJobPoller).mockReturnValue(stopped);
    const settled = vi.fn();
    const view = render(<JobAiActivity projectId="p" jobId="old" onSettled={settled} />);
    view.rerender(<JobAiActivity projectId="p" jobId="old" onSettled={settled} />);
    expect(settled).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('重读'));
    expect(useVisibleJobPoller).toHaveBeenLastCalledWith('old', 1);
    expect(retryBackendJob).not.toHaveBeenCalled();
  });
  it('drops an old resumed attempt when a different business job becomes current', async () => {
    vi.mocked(useVisibleJobPoller).mockReturnValue(stopped);
    vi.mocked(retryBackendJob).mockResolvedValue('resumed');
    const view = render(<JobAiActivity projectId="p" jobId="old" />);
    fireEvent.click(screen.getByText('继续'));
    await waitFor(() => expect(useVisibleJobPoller).toHaveBeenLastCalledWith('resumed', 0));
    view.rerender(<JobAiActivity projectId="p" jobId="different" />);
    expect(useVisibleJobPoller).toHaveBeenLastCalledWith('different', 0);
  });
});
