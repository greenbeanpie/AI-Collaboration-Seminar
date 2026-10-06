import { errorMessage } from '../../api/error-info';
import { ErrorNotice, Spinner } from '../../components/ui';
import { jobStatusLabel, useVisibleJobPoller } from '../../pages/aiWorkflowSupport';

export function JobProgress({ job }: { job: ReturnType<typeof useVisibleJobPoller> }) {
  const result = job.job?.result && typeof job.job.result === 'object' ? job.job.result as Record<string, unknown> : null;
  const reasons = Array.isArray(result?.manualReviewReasons) ? result.manualReviewReasons.filter((value): value is string => typeof value === 'string') : [];
  const error = job.job?.error;
  const message = errorMessage(error, '执行失败。');
  return <>{job.loading && <Spinner label="读取 AI 任务进度" />}{job.error && <ErrorNotice error={job.error} />}{job.job && <div className={`notice ${job.job.status === 'failed' ? 'notice-error' : ''}`}>AI 任务：{jobStatusLabel(job.job.status)}{job.job.status === 'failed' && <span style={{whiteSpace:'pre-wrap'}}>{message}</span>}{job.job.status === 'succeeded' && typeof result?.autoApplied === 'boolean' && <span> · {result.autoApplied ? '已按自动模式应用' : '未自动应用，请负责人核验并确认'}</span>}</div>}{typeof result?.followupError === 'string' && <p className="notice notice-warn" style={{whiteSpace:'pre-wrap'}}>{result.followupError}</p>}{typeof result?.applyError === 'string' && <p className="notice notice-warn" style={{whiteSpace:'pre-wrap'}}>{result.applyError}</p>}{reasons.length > 0 && <div className="callout"><strong>需要人工核验</strong><ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}</>;
}

