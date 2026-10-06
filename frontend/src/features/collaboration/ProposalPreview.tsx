import { AiReferenceBadge } from '../../components/AiReferenceBadge';
import type { CollaborationTask } from '../../api/collaboration';

export function ProposalPreview({ payload, members, tasks }: { payload: Record<string, unknown>; members: { userId: string; displayName: string }[]; tasks: CollaborationTask[] }) {
  const entries = [...(Array.isArray(payload.tasks) ? payload.tasks : []), ...(Array.isArray(payload.updates) ? payload.updates : []), ...(Array.isArray(payload.assignments) ? payload.assignments : [])];
  const goal = payload.goal && typeof payload.goal === 'object' ? payload.goal as { title?: string; detail?: string } : null;
  return <>{goal && <div className="callout"><strong>建议主目标：{goal.title}<AiReferenceBadge ariaHidden /></strong><p>{goal.detail}</p></div>}<ul>{entries.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object') return null;
    const row = entry as Record<string, unknown>;
    return <li key={index}><AiReferenceBadge /><strong>{typeof row.title === 'string' ? row.title : tasks.find(task => task.taskId === row.taskId)?.title ?? String(row.taskId ?? '任务')}</strong>{typeof row.criteria === 'string' && <p>{row.criteria}</p>}{Array.isArray(row.dependsOn) && row.dependsOn.length > 0 && <p>前置：{row.dependsOn.map(key => { const predecessor = entries.find(item => item && typeof item === 'object' && 'key' in item && item.key === key) as { title?: string } | undefined; return predecessor?.title ?? tasks.find(task => task.taskId === key)?.title ?? String(key); }).join('、')}</p>}{typeof row.effortHours === 'number' && <small>预计 {row.effortHours} 小时 · </small>}{typeof row.assigneeId === 'string' && <span>{members.find(member => member.userId === row.assigneeId)?.displayName ?? row.assigneeId}</span>}{typeof row.reason === 'string' && <p>{row.reason}</p>}{Array.isArray(row.citations) && row.citations.length > 0 && <details><summary>任务来源原文依据<AiReferenceBadge ariaHidden /></summary>{row.citations.map((citation: unknown, citeIndex: number) => { const cite = citation as { sourceVersionId?: string; pageNumber?: number | null; quote?: string; availability?: 'unavailable'; deletedAt?: string | null }; return <p className="collab-preserve" key={citeIndex}>固定来源 {cite.sourceVersionId}{cite.pageNumber ? ` · 第${cite.pageNumber}页` : ''}：{cite.quote}{cite.availability === 'unavailable' && <small> · 原始来源不可用{cite.deletedAt ? '（已移入回收站）' : ''}，历史引文保留</small>}</p>; })}</details>}</li>;
  })}</ul></>;
}

