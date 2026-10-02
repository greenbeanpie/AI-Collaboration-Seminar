import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import { presentEvent } from './event-presentation';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, EmptyState, SectionCard, Spinner, StatusPill } from '../components/ui';

export function LedgerPage() {
  const { projectId } = useProject();
  return <LedgerWorkspace key={projectId} />;
}

function LedgerWorkspace() {
  const { projectId } = useProject();
  const [pageSize, setPageSize] = useState(10);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const cursor = cursors[pageIndex] ?? null;
  const eventsQuery = useQuery({
    queryKey: ['events', projectId, 'page', pageSize, cursor],
    queryFn: ({ signal }) => api.get<'EventListResponse'>(projectPath(projectId, '/events'), { limit: pageSize, cursor }, signal),
  });
  const events = eventsQuery.data?.items ?? [];
  const paginationBusy = eventsQuery.isFetching;

  return <div className="page-stack ledger-page">
    <SectionCard title="事件流" detail="按发生时间列出任务、成果与 AI 操作，保留历史事件。" action={<StatusPill tone="blue">本页 {eventsQuery.isPending || eventsQuery.isError ? '—' : events.length} 条</StatusPill>}>
      {eventsQuery.isPending ? <Spinner label="正在读取事件记录" /> : eventsQuery.isError ? <ErrorNotice error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} /> : events.length ? <div className="ledger-timeline">{events.map((event) => { const activity = presentEvent(event); return <div className="ledger-line" key={event.eventId}><span className={`ledger-marker actor-${event.actorType}`} /><div className="ledger-content"><div className="ledger-event-title"><strong>{activity.title}</strong><span>{activity.actor}</span></div><p>{activity.detail}</p><small>{new Date(event.occurredAt).toLocaleString('zh-CN')}</small></div></div>; })}</div> : <EmptyState title="暂无事件记录" detail="任务、成果或 AI 操作发生后，事件会出现在这里。" />}
      <nav className="ledger-pagination" aria-label="事件流分页">
        <label className="ledger-page-size">每页条数<select className="input" aria-label="每页条数" value={pageSize} disabled={paginationBusy} onChange={event => { setPageSize(Number(event.target.value)); setCursors([null]); setPageIndex(0); }}><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option></select></label>
        <span aria-live="polite">第 {pageIndex + 1} 页</span>
        <div className="button-row">
          <button type="button" className="button button-quiet" disabled={paginationBusy || pageIndex === 0} onClick={() => setPageIndex(index => index - 1)}>上一页</button>
          <button type="button" className="button button-quiet" disabled={paginationBusy || eventsQuery.isError || !eventsQuery.data?.nextCursor} onClick={() => {
            const nextCursor = eventsQuery.data?.nextCursor;
            if (!nextCursor) return;
            setCursors(current => [...current.slice(0, pageIndex + 1), nextCursor]);
            setPageIndex(index => index + 1);
          }}>下一页</button>
        </div>
      </nav>
    </SectionCard>

  </div>;
}
