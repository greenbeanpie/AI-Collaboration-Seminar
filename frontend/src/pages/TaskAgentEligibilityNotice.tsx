import type { useTaskAgentEligibility } from './useTaskAgentEligibility';

export function TaskAgentEligibilityNotice({ eligibility, reasonId }: { eligibility: ReturnType<typeof useTaskAgentEligibility>; reasonId?: string }) {
  return <>
    {eligibility.reason && <small id={reasonId} className="notice notice-warn collab-agent-reason" role="status">{eligibility.reason}</small>}
    {eligibility.readError && <button className="button button-quiet button-small" disabled={eligibility.loading} onClick={eligibility.reload}>重试读取判断</button>}
    {eligibility.canCheck && <button className="button button-quiet button-small" onClick={eligibility.check}>{eligibility.retry ? '重试 AI 适用性检查' : '检查 AI 适用性'}</button>}
  </>;
}
