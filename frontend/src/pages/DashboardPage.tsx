import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, CheckCheck, Clock3, FolderKanban, LayoutGrid, List, Plus, UsersRound } from 'lucide-react';
import { listAllItems } from '../api/client';
import type { ProjectSummary, Task } from '../api/types';
import { ErrorNotice, EmptyState, Modal, PageHeading, Spinner, StatusPill } from '../components/ui';
import { TaskCompletionMetric } from '../components/TaskCompletionMetric';
import { deadlineBarStyle, deadlineSummary, pendingProjectGroups, projectDisplayStatus, remainingDays, uniqueProjectTasks, type ProjectDisplayStatus } from './dashboard-summary';
import './DashboardPage.css';

const statusLabels = { pending: '待响应', active: '进行中', done: '已完成', archived: '已归档', unknown: '进度待确认' };
const taskLabels = { todo: '待开始', doing: '进行中', blocked: '受阻', done: '已完成' };
function dateLabel(date: string | null, precision: string) {
  if (!date || precision === 'unknown') return '截止日期待确认';
  const parsed = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(parsed.getTime())) return '截止日期待确认';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(parsed);
}

function ProjectCard({ project, tasks, error, status }: { project: ProjectSummary; tasks?: readonly Task[]; error?: unknown; status: ProjectDisplayStatus }) {
  const done = tasks?.filter(task => task.status === 'done').length ?? 0;
  const progress = tasks?.length ? Math.round(done / tasks.length * 100) : 0;
  return <Link className={`project-card card dashboard-project is-${status}`} to={`/app/projects/${encodeURIComponent(project.id)}`}>
    <div className="project-card-top"><StatusPill tone={status === 'pending' ? 'warn' : status === 'done' ? 'good' : status === 'active' ? 'blue' : 'neutral'}>{statusLabels[status]}</StatusPill><span className="dashboard-role"><UsersRound size={13} />{project.myRole === 'owner' ? '负责人' : '成员'}</span></div>
    <div className="dashboard-project-copy"><h2>{project.name} <AiReferenceBadge ariaHidden /></h2><p className="project-card-description">{project.description || '尚未添加项目说明。'} <AiReferenceBadge /></p></div>
    <div className="project-card-meta"><span><CalendarDays size={14} />{dateLabel(project.deadlineDate, project.deadlinePrecision)} <AiReferenceBadge ariaHidden /></span></div>
    {error ? <div className="card-inline-error">任务进度暂不可用</div> : tasks ? <div className="progress-block"><div className="progress-label"><span>{done} / {tasks.length} 项任务完成 <AiReferenceBadge ariaHidden /></span><strong>{progress}%</strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div> : <div className="progress-loading">读取项目任务进度…</div>}
    <span className="project-card-link">进入项目 <ArrowUpRight size={14} /></span>
  </Link>;
}

function DeadlineMetric({ tasks, available }: { tasks: readonly Task[]; available: boolean }) {
  const summary = deadlineSummary(tasks);
  const max = Math.max(1, ...summary.bins);
  return <div className="dashboard-metric dashboard-deadline">
    <span className="dashboard-metric-label"><CheckCheck size={16} />待响应任务 <AiReferenceBadge ariaHidden /></span>
    <div className="dashboard-deadline-main"><strong className="dashboard-metric-value">{available ? tasks.length : '—'}<small>项</small></strong>
      {available && <div className="dashboard-deadline-chart" role="img" aria-label={`待响应任务截止分布，从14日及以上至今日：${summary.bins.map((count, index) => `${14 - index}日${count}项`).join('，')}`}>
        {summary.bins.map((count, index) => <div className="dashboard-deadline-bin" key={index} title={`截止还有 ${index === 0 ? '14 日及以上' : `${14 - index} 日`}：${count} 项`}><span style={{ ...deadlineBarStyle(14 - index), height: `${count / max * 100}%` }} /></div>)}
      </div>}
    </div>
    <div className="dashboard-deadline-hints" aria-label="累计截止提醒，包含今日"><span className="deadline-today">今日截止 {available ? summary.today : '—'} 项</span><span className="deadline-three">最近3日截止 {available ? summary.three : '—'} 项</span><span className="deadline-seven">最近7日截止 {available ? summary.seven : '—'} 项</span></div>
  </div>;
}

export function DashboardPage() {
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [searchParams, setSearchParams] = useSearchParams();
  const archiveOpen = searchParams.get('archive') === '1';
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: () => listAllItems<'ProjectListResponse'>('/api/v1/projects', { status: 'all', limit: 100 }, { requireNextCursor: true }) });
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const taskQueries = useQueries({ queries: projects.map(project => ({
    queryKey: ['tasks', project.id], queryFn: () => listAllItems<'TaskListResponse'>(`/api/v1/projects/${encodeURIComponent(project.id)}/tasks`, { limit: 100 }, { requireNextCursor: true }), staleTime: 10_000,
  })) });
  const memberQueries = useQueries({ queries: projects.map(project => ({
    queryKey: ['members', project.id], queryFn: () => listAllItems<'MemberListResponse'>(`/api/v1/projects/${encodeURIComponent(project.id)}/members`), staleTime: 10_000, enabled: project.status !== 'archived',
  })) });
  const entries = projects.map((project, index) => ({ project, tasks: taskQueries[index]?.data ? uniqueProjectTasks(taskQueries[index].data) : undefined, members: memberQueries[index]?.data, error: taskQueries[index]?.error, memberError: memberQueries[index]?.error, status: projectDisplayStatus(project, taskQueries[index]?.error ? undefined : taskQueries[index]?.data) }));
  const current = entries.filter(entry => entry.status !== 'archived');
  const archived = entries.filter(entry => entry.status === 'archived');
  const available = !projectsQuery.error && current.every(entry => entry.tasks !== undefined && !entry.error);
  const allTasks = current.flatMap(entry => entry.tasks ?? []);
  const actionableAvailable = available && current.every(entry => entry.members !== undefined && !entry.memberError);
  const pendingProjects = pendingProjectGroups(current);
  const pending = pendingProjects.flatMap(entry => entry.actionable);
  const completed = allTasks.filter(task => task.status === 'done').length;
  const visible = current.filter(entry => filter === 'all' || (filter === 'active' ? entry.status === 'active' || entry.status === 'pending' : entry.status === 'done'));
  const summary = deadlineSummary(pending);
  const firstTaskError = current.find(entry => entry.error)?.error;
  const firstMemberError = current.find(entry => entry.memberError)?.memberError;
  const attentionError = firstTaskError || firstMemberError;
  function closeArchive() { const next = new URLSearchParams(searchParams); next.delete('archive'); setSearchParams(next, { replace: true }); }

  if (projectsQuery.isLoading) return <div className="content-wrap"><Spinner label="正在加载项目" /></div>;
  return <div className="page-stack dashboard-page">
    <PageHeading eyebrow="工作空间 / 总览" title="我的项目" detail="让每个项目有序向前，让下一步清晰可见。" action={<Link className="button button-primary" to="/app/projects/new"><Plus size={17} />新建项目</Link>} />
    {projectsQuery.error && <ErrorNotice error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />}
    <div className="dashboard-metrics">
      <div className="dashboard-metric"><span className="dashboard-metric-label"><FolderKanban size={16} />进行中的项目</span><strong className="dashboard-metric-value">{available ? current.filter(entry => entry.status !== 'done').length : '—'}<small>个</small></strong><span className="dashboard-metric-foot">{projectsQuery.error ? '项目暂不可用' : `共 ${current.length} 个项目 · ${archived.length} 个已归档`}</span></div>
      <DeadlineMetric tasks={pending} available={actionableAvailable} />
      <TaskCompletionMetric variant="dashboard" completed={completed} total={allTasks.length} available={available} unavailableMessage={projectsQuery.error || firstTaskError ? '任务统计暂不可用' : '正在读取任务进度'} />
      <Link className="dashboard-metric dashboard-join" to="/app/join"><span className="dashboard-metric-label">加入现有团队</span><strong>项目邀请</strong><span>输入邀请码，或处理收到的邀请</span><span className="dashboard-join-link">查看并接受邀请 <ArrowUpRight size={14} /></span></Link>
    </div>
    {attentionError && <ErrorNotice error={attentionError} onRetry={() => { [...taskQueries, ...memberQueries].forEach(query => { if (query.error) void query.refetch(); }); }} />}
    <div className="dashboard-columns">
      <section className="dashboard-projects" aria-label="项目区">
        <div className="dashboard-section-head"><h2>项目 <small>{visible.length} 个</small></h2><div className="dashboard-segment" aria-label="项目视图"><button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={14} />网格</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} />列表</button></div><div className="dashboard-filters" aria-label="项目筛选">{(['all', 'active', 'done'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : value === 'active' ? '进行中' : '已完成'}</button>)}</div></div>
        <div className="dashboard-filter-note">进行中包含待响应 · 已完成表示项目内全部任务完成</div>
        {projectsQuery.error ? <div className="card"><EmptyState title="项目列表暂不可用" detail="请重试加载项目。" /></div> : visible.length === 0 ? <div className="card"><EmptyState title={current.length ? '暂无此类项目' : '还没有项目'} detail="创建项目，或使用邀请代码加入团队。" action={<Link className="button button-quiet" to="/app/projects/new"><Plus size={16} />新建项目</Link>} /></div> : <div className={`dashboard-project-collection dashboard-view-${view}`}>{visible.map(entry => <ProjectCard key={entry.project.id} {...entry} />)}</div>}
      </section>
      <aside className="dashboard-attention card" aria-label="待响应事项"><div className="dashboard-section-head"><h2><Clock3 size={16} />待响应事项</h2><small>{actionableAvailable ? pending.length : '—'} 项可完成</small></div><p className="dashboard-attention-intro">按项目查看已分配、前置任务已完成的未完成任务。</p>
        {!actionableAvailable ? <p className="dashboard-attention-empty">{projectsQuery.error || attentionError ? '任务暂不可用，请重试。' : '正在读取待响应事项…'}</p> : pendingProjects.length === 0 ? <EmptyState title="暂时没有待响应事项" detail="当前没有可完成任务。" /> : <div className="dashboard-attention-list">{pendingProjects.map(({ project, actionable }) => <section className="dashboard-attention-project" key={project.id} aria-label={project.name}>
          <Link className="dashboard-attention-project-link" to={`/app/projects/${encodeURIComponent(project.id)}`}><strong>{project.name} <AiReferenceBadge ariaHidden /></strong><span>{actionable.length} 项可完成</span><ArrowUpRight size={14} /></Link>
          {actionable.length === 0 ? <p className="dashboard-project-waiting">暂无可完成任务</p> : <ul className="dashboard-project-tasks">{actionable.map(task => {
            const days = remainingDays(task);
            return <li key={task.taskId}><Link className="dashboard-task" to={`/app/projects/${encodeURIComponent(project.id)}/tasks?task=${encodeURIComponent(task.taskId)}`}><span className={`dashboard-task-dot ${days !== null && days <= 0 ? 'urgent' : ''}`} /><span><strong>{task.title} <AiReferenceBadge ariaHidden /></strong><span className={`dashboard-task-due ${days !== null && days <= 0 ? 'urgent' : ''}`}>{days === null ? '截止待确认' : days < 0 ? `已逾期 ${-days} 日` : days === 0 ? '今日截止' : `截止还有 ${days} 日`} <AiReferenceBadge ariaHidden /></span></span></Link></li>;
          })}</ul>}
        </section>)}</div>}
        {actionableAvailable && (summary.overdue > 0 || summary.undated > 0) && <p className="dashboard-attention-note">{summary.overdue} 项已逾期 · {summary.undated} 项截止待确认（未计入柱状图）</p>}
      </aside>
    </div>
    {archiveOpen && <Modal title="归档任务" onClose={closeArchive}><p className="dashboard-archive-note">已归档项目及其任务，仅供回顾。归档与完成状态分别记录。</p>{projectsQuery.error ? <ErrorNotice error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} /> : archived.length === 0 ? <EmptyState title="暂无归档任务" /> : <div className="dashboard-archive-list">{archived.map(({ project, tasks, error }) => <section key={project.id}><Link className="dashboard-archive-project" to={`/app/projects/${encodeURIComponent(project.id)}`}>{project.name} <AiReferenceBadge ariaHidden /><ArrowUpRight size={14} /></Link>{error ? <ErrorNotice error={error} onRetry={() => void taskQueries[projects.findIndex(item => item.id === project.id)].refetch()} /> : !tasks ? <Spinner label="正在读取归档任务" /> : tasks.length === 0 ? <p>此项目暂无任务。</p> : tasks.map(task => <Link className="dashboard-archive-task" key={task.taskId} to={`/app/projects/${encodeURIComponent(project.id)}/tasks?task=${encodeURIComponent(task.taskId)}`}><span>{task.title} <AiReferenceBadge ariaHidden /></span><StatusPill tone="neutral">{taskLabels[task.status]}</StatusPill></Link>)}</section>)}</div>}</Modal>}
  </div>;
}
