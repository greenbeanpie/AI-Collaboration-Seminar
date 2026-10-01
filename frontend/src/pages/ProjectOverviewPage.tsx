import { useSession } from '../auth';
import { PendingTaskPreview } from '../components/PendingTaskPreview';
import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarCheck2, FileText, ListTodo, UsersRound } from 'lucide-react';
import { listAllItems, projectPath } from '../api/client';
import { presentEvent } from './event-presentation';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, EmptyState, SectionCard, Spinner, StatusPill } from '../components/ui';

const modules = [
  { key: 'tasks', title: '任务', path: 'tasks', icon: ListTodo },
  { key: 'members', title: '团队成员', path: 'team', icon: UsersRound },
  { key: 'materials', title: '材料', path: 'materials', icon: FileText },
  { key: 'sources', title: '通知来源', path: 'sources', icon: CalendarCheck2 },
] as const;

export function ProjectOverviewPage() {
  const session = useSession();
  const { projectId, project } = useProject();
  const queries = useQueries({ queries: [
    { queryKey: ['tasks', projectId], queryFn: () => listAllItems<'TaskListResponse'>(projectPath(projectId, '/tasks'), { limit: 100 }, { requireNextCursor: true }) },
    { queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members'), { limit: 100 }) },
    { queryKey: ['materials', projectId], queryFn: () => listAllItems<'MaterialListResponse'>(projectPath(projectId, '/materials'), { limit: 100 }, { requireNextCursor: true }) },
    { queryKey: ['sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }) },
    { queryKey: ['requirementSets', projectId], queryFn: () => listAllItems<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), { limit: 100 }) },
    { queryKey: ['events', projectId], queryFn: () => listAllItems<'EventListResponse'>(projectPath(projectId, '/events'), { limit: 100 }, { requireNextCursor: true }) },
  ] });
  const [tasks, members, materials, sources, requirementSets, events] = queries;
  const taskItems = tasks.data ?? [];
  const done = taskItems.filter((task) => task.status === 'done').length;
  const draftSets = requirementSets.data?.filter((set) => set.status !== 'confirmed').length;
  const checklistDataReady = Boolean(tasks.data && sources.data && requirementSets.data);
  const hasOpenTasks = taskItems.some((task) => task.status !== 'done');
  const missingDeadline = !project.deadlineDate || project.deadlinePrecision === 'unknown';
  const errors = queries.filter((query) => query.error);
  if (queries.every((query) => query.isLoading)) return <Spinner label="正在读取项目进度" />;

  return <div className="page-stack project-overview-page">
    <div className="overview-welcome"><div><span className="eyebrow">项目进度</span><h1>一起把下一步做好</h1><p>此处汇总项目服务中已保存的任务、成员、材料与要求状态。</p></div><Link to={`/app/projects/${projectId}/tasks`} className="button button-primary">查看任务 <ArrowRight size={16} /></Link></div>
    {errors.length > 0 && <div className="stack">{errors.map((query, i) => <ErrorNotice key={i} error={query.error} onRetry={() => void query.refetch()} />)}</div>}
    <div className="metric-grid overview-metrics">
      <div className="metric-card"><span>任务完成</span><strong>{tasks.data ? `${done}/${taskItems.length}` : '—'}</strong><small>按服务端任务状态计算</small></div>
      <div className="metric-card"><span>团队成员</span><strong>{members.data?.length ?? '—'}</strong><small>当前项目成员</small></div>
      <div className="metric-card"><span>待确认要求</span><strong>{draftSets ?? '—'}</strong><small>已解析要求集中的草稿</small></div>
      <div className="metric-card"><span>材料版本</span><strong>{materials.data?.filter((item) => item.currentVersionId).length ?? '—'}</strong><small>已有正式版本的材料</small></div>
    </div>
    <div className="two-column overview-columns">
      <SectionCard title="协作模块" detail="直接进入需要处理的项目内容。">
        <div className="module-links">{modules.map(({ key, title, path, icon: Icon }) => {
          const query = ({ tasks, members, materials, sources } as const)[key];
          const count = query.data?.length;
          return <Link className="module-link" key={key} to={`/app/projects/${projectId}/${path}`}><span className="module-icon"><Icon size={18} /></span><span className="module-link-main"><strong>{title}</strong><small>{count === undefined ? '服务数据暂不可用' : `${count} 项记录`}</small></span><ArrowRight size={16} /></Link>;
        })}</div>
      </SectionCard>
      <SectionCard title="待处理事项" detail="最新两项未完成任务，优先显示由你负责的任务。">
        <div className="card-list">
          {!tasks.error && <PendingTaskPreview tasks={taskItems} userId={session.data?.id} projectId={projectId} />}
          {missingDeadline && <Link className="list-row attention-row" to={`/app/projects/${projectId}/settings`}><span className="attention-mark">!</span><span className="list-row-main"><strong>截止日期尚未确认</strong><p>项目设置中可记录官方通知中的日期精度。</p></span><ArrowRight size={15} /></Link>}
          {sources.data?.length === 0 && <Link className="list-row attention-row" to={`/app/projects/${projectId}/sources`}><span className="attention-mark">+</span><span className="list-row-main"><strong>导入通知或项目资料</strong><p>粘贴原文、填写公开网址或上传文件后再提取要求。</p></span><ArrowRight size={15} /></Link>}
          {draftSets !== undefined && draftSets > 0 && <Link className="list-row attention-row" to={`/app/projects/${projectId}/requirements`}><span className="attention-mark">{draftSets}</span><span className="list-row-main"><strong>有要求集等待人工确认</strong><p>系统提取内容保持草稿状态，负责人确认后才成为正式要求。</p></span><ArrowRight size={15} /></Link>}
          {checklistDataReady && !missingDeadline && Boolean(sources.data?.length) && !draftSets && !hasOpenTasks && <EmptyState title="暂无待处理事项" detail="系统没有从当前项目记录中发现待处理内容。" />}
        </div>
      </SectionCard>
    </div>
    <SectionCard title="最近活动" detail="来自项目事件流，记录决策、贡献和 AI 操作。" action={<Link className="button button-quiet button-small" to={`/app/projects/${projectId}/ledger`}>打开过程账本</Link>}>
      {events.isLoading ? <Spinner label="读取项目事件" /> : events.error ? <ErrorNotice error={events.error} onRetry={() => void events.refetch()} /> : events.data?.length ? <div className="ledger-timeline">{events.data.slice(0, 8).map((event) => { const activity = presentEvent(event); return <div className="ledger-line" key={event.eventId}><span className="ledger-marker" /><div className="ledger-content"><strong>{activity.title}</strong><p>{activity.detail}</p><small>{activity.actor} · {new Date(event.occurredAt).toLocaleString('zh-CN')}</small></div></div>; })}</div> : <EmptyState title="还没有过程记录" detail="补录决策、贡献或 AI 使用信息后，会在这里显示。" />}
    </SectionCard>
    <div className="overview-footer-note"><StatusPill tone="blue">项目空间</StatusPill><span>此页面只呈现 API 返回的真实记录；每个数字在对应数据未加载时保持为空。</span></div>
  </div>;
}
