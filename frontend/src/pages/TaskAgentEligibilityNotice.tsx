import { JobAiActivity } from './JobAiActivity';
import type { useTaskAgentEligibility } from './useTaskAgentEligibility';

export function TaskAgentEligibilityNotice({ eligibility, reasonId, projectId }: { eligibility: ReturnType<typeof useTaskAgentEligibility>; reasonId?: string; projectId?: string }) {
  return <>
    {projectId && <JobAiActivity projectId={projectId} jobId={eligibility.result?.jobId} submitting={eligibility.pending && !eligibility.result?.jobId} onSettled={eligibility.reload} canResume={eligibility.retry} />}
    {eligibility.reason && <small id={reasonId} className="collab-agent-reason" role="status" style={{whiteSpace:'pre-wrap'}}>{eligibility.reason}</small>}
    {eligibility.readError && <button className="button button-quiet button-small" disabled={eligibility.loading} onClick={eligibility.reload}>重试读取判断</button>}
    {eligibility.canCheck && !eligibility.result?.jobId && <button className="button button-quiet button-small" onClick={eligibility.check}>重试自动判断</button>}
  </>;
}
