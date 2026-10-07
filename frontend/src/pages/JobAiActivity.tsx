import { executionOf } from '../api/ai-execution';
import { useEffect, useRef, useState } from 'react';
import { AiActivityStatus } from '../components/AiActivityStatus';
import { ErrorNotice } from '../components/ui';
import { retryBackendJob, useVisibleJobPoller } from './aiWorkflowSupport';

/** Keeps completed activity visible and follows the new attempt after a resume. */
export function JobAiActivity({ projectId, jobId, submitting = false, onSettled, onResumed, canResume = true }: {
  projectId: string; jobId?: string | null; submitting?: boolean;
  onSettled?: () => void; onResumed?: (jobId: string) => void; canResume?: boolean;
}) {
  const [attempt, setAttempt] = useState<{ source: string; id: string } | null>(null);
  const currentId = attempt && attempt.source === jobId ? attempt.id : jobId ?? null;
  const [refreshKey, setRefreshKey] = useState(0);
  const poll = useVisibleJobPoller(currentId, refreshKey);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const notified = useRef<string | null>(null);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;
  useEffect(() => {
    if (!poll.job || !poll.isSettled) return;
    const key = `${poll.job.jobId}:${poll.job.status}`;
    if (notified.current === key) return;
    notified.current = key;
    settledCallback.current?.();
  }, [poll.job, poll.isSettled]);
  const resume = async () => {
    if (lock.current || !currentId || !canResume) return;
    lock.current = true; setResuming(true); setError(null);
    try {
      const id = await retryBackendJob(projectId, currentId);
      setAttempt({ source: jobId ?? '', id });
      onResumed?.(id);
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setResuming(false); }
  };
  if (!jobId && !submitting) return null;
  return <><AiActivityStatus job={poll.job} jobId={currentId ?? undefined} submitting={submitting}
    loading={poll.loading} readError={poll.error} onRefresh={() => setRefreshKey(value => value + 1)}
    executionEnabled={canResume} onResume={canResume && executionOf(poll.job)?.state !== 'paused' ? resume : undefined} resuming={resuming} />
    {Boolean(error) && <ErrorNotice error={error} />}</>;
}
