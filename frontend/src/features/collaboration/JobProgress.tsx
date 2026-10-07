import { AiActivityStatus } from '../../components/AiActivityStatus';
import { useVisibleJobPoller } from '../../pages/aiWorkflowSupport';

export function JobProgress({ job, submitting, onResume, resuming }: { job: ReturnType<typeof useVisibleJobPoller>; submitting?: boolean; onResume?: () => void | Promise<void>; resuming?: boolean }) {
  const result = job.job?.result && typeof job.job.result === 'object' ? job.job.result as Record<string, unknown> : null;
  const reasons = Array.isArray(result?.manualReviewReasons) ? result.manualReviewReasons.filter((value): value is string => typeof value === 'string') : [];
  return <><AiActivityStatus job={job.job} submitting={submitting} loading={job.loading} readError={job.error} onRefresh={job.refresh} onResume={onResume} resuming={resuming} />{job.job?.status === 'succeeded' && typeof result?.autoApplied === 'boolean' && <p>{result.autoApplied ? '已按自动模式应用' : '未自动应用，请负责人核验并确认'}</p>}{typeof result?.followupError === 'string' && <p className="notice notice-warn" style={{whiteSpace:'pre-wrap'}}>{result.followupError}</p>}{typeof result?.applyError === 'string' && <p className="notice notice-warn" style={{whiteSpace:'pre-wrap'}}>{result.applyError}</p>}{reasons.length > 0 && <div className="callout"><strong>需要人工核验</strong><ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}</>;
}

