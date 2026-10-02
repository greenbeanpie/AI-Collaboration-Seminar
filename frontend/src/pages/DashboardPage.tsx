import { ReceivedInvitations } from './UsernameInvitations';
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, FolderPlus, Plus, UsersRound } from 'lucide-react';
import { listAllItems } from '../api/client';
import type { ProjectSummary } from '../api/types';
import { ErrorNotice, EmptyState, PageHeading, Spinner, StatusPill } from '../components/ui';

function dateLabel(date: string | null, precision: string) {
  if (!date || precision === 'unknown') return '截止日期待确认';
  const parsed = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(parsed);
}

function ProjectCard({ project, taskCount, doneCount, taskError }: { project: ProjectSummary; taskCount?: number; doneCount?: number; taskError?: unknown }) {
  const progress = taskCount ? Math.round((doneCount ?? 0) / taskCount * 100) : 0;
  return <Link className="project-card card" to={`/app/projects/${project.id}`}>
    <div className="project-card-top"><div className="project-icon"><FolderPlus size={19} /></div><StatusPill tone={project.status === 'active' ? 'good' : 'neutral'}>{project.status === 'active' ? '进行中' : '已归档'}</StatusPill></div>
    <h2>{project.name}</h2><p className="project-card-description">{project.description || '尚未添加项目说明。'}</p>
    <div className="project-card-meta"><span><CalendarDays size={15} />{dateLabel(project.deadlineDate, project.deadlinePrecision)}</span><span><UsersRound size={15} />{project.myRole === 'owner' ? '负责人' : '成员'}</span></div>
    {taskError ? <div className="card-inline-error">任务进度暂不可用</div> : taskCount !== undefined ? <div className="progress-block"><div className="progress-label"><span>{doneCount} / {taskCount} 项任务完成</span><strong>{progress}%</strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div> : <div className="progress-loading">读取项目任务进度…</div>}
    <span className="project-card-link">进入项目 <ArrowUpRight size={15} /></span>
  </Link>;
}

export function DashboardPage() {
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: () => listAllItems<'ProjectListResponse'>('/api/v1/projects', { status: 'all', limit: 100 }, { requireNextCursor: true }) });
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const taskQueries = useQueries({ queries: projects.map((project) => ({
    queryKey: ['tasks', project.id],
    queryFn: () => listAllItems<'TaskListResponse'>(`/api/v1/projects/${project.id}/tasks`, { limit: 100 }, { requireNextCursor: true }),
    staleTime: 10_000,
  })) });
  const counts = useMemo(() => projects.map((project, index) => {
    const result = taskQueries[index]?.data;
    return { project, total: result?.length, done: result?.filter((task) => task.status === 'done').length, error: taskQueries[index]?.error };
  }), [projects, taskQueries]);
  const active = projects.filter((project) => project.status === 'active').length;
  const openTasks = taskQueries.reduce((sum, query) => sum + (query.data?.filter((task) => task.status !== 'done').length ?? 0), 0);

  if (projectsQuery.isLoading) return <div className="content-wrap"><Spinner label="正在加载项目" /></div>;
  return <div className="page-stack">
    <PageHeading eyebrow="工作空间 / 总览" title="我的项目" detail="回到真实项目现场，查看团队进度和下一步要处理的事项。" action={<Link className="button button-primary" to="/app/projects/new"><Plus size={17} />新建项目</Link>} />
    {projectsQuery.error && <ErrorNotice error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />}
    <ReceivedInvitations/>
    <div className="metric-grid"><div className="metric-card"><span>参与项目</span><strong>{projectsQuery.data?.length ?? '—'}</strong><small>{projectsQuery.error ? '项目列表不可用' : `${active} 个进行中`}</small></div><div className="metric-card"><span>待完成任务</span><strong>{projectsQuery.error || taskQueries.some((query) => query.error) ? '—' : openTasks}</strong><small>已读取全部项目分页数据</small></div><div className="metric-card metric-callout"><span>加入现有团队</span><strong>有邀请代码？</strong><Link to="/app/join">输入代码加入 <ArrowUpRight size={14} /></Link></div></div>
    <div className="section-head standalone-head"><div><h2>项目列表</h2><p>账户在后端可访问的项目</p></div><Link className="button button-quiet button-small" to="/app/join">接受邀请</Link></div>
    {projectsQuery.error ? <div className="card"><ErrorNotice error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} /></div> : projects.length === 0 ? <div className="card"><EmptyState title="还没有项目" detail="创建一个项目，或使用负责人发来的邀请代码加入。" action={<div className="empty-actions"><Link to="/app/projects/new" className="button button-primary"><Plus size={16} />创建第一个项目</Link><Link to="/app/join" className="button button-quiet">输入邀请代码</Link></div>} /></div> : <div className="project-grid">{counts.map(({ project, total, done, error }) => <ProjectCard key={project.id} project={project} taskCount={total} doneCount={done} taskError={error} />)}</div>}
    <div className="data-origin-note"><span className="origin-dot" />项目内容由真实 API 提供。空列表表示当前账户尚未加入项目。</div>
  </div>;
}
