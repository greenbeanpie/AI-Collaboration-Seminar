import { useSession } from '../auth';
import { PendingTaskPreview } from '../components/PendingTaskPreview';
import { TaskCompletionMetric } from '../components/TaskCompletionMetric';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { listAllItems, projectPath } from '../api/client';
import { projectRequest, type ProjectGoal } from '../api/simplification';
import { useProject } from '../components/ProjectShell';
import { projectPermission } from '../project-permissions';
import './ProjectWorkspace.css';
import { ErrorNotice, EmptyState, SectionCard, Spinner } from '../components/ui';

export function ProjectOverviewPage() {
  const session = useSession();
  const { projectId, project } = useProject();
  const goal = useQuery({ queryKey: ['project-goal', projectId], queryFn: () => projectRequest<ProjectGoal>(projectId, '/goal') });
  // 审批队列由 teamManage 决定；无该权限时列表接口只返回本人申请，故无需请求。
  const invitationRequests = useQuery({ queryKey: ['invitation-requests', projectId], queryFn: () => projectRequest<{ items: { status: string }[] }>(projectId, '/invitation-requests'), enabled: projectPermission(project, 'teamManage') && navigator.onLine !== false });
  const pendingInvitations = invitationRequests.data?.items.filter(item => item.status === 'pending').length ?? 0;
  const queries = useQueries({ queries: [
    { queryKey: ['tasks', projectId], queryFn: () => listAllItems<'TaskListResponse'>(projectPath(projectId, '/tasks'), { limit: 100 }, { requireNextCursor: true }) },
    { queryKey: ['sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }) },
    { queryKey: ['requirementSets', projectId], queryFn: () => listAllItems<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), { limit: 100 }) },
  ] });
  const [tasks, sources, requirementSets] = queries;
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
    <div className="project-overview-columns"><div><SectionCard aiReference title="项目主目标" detail="主目标独立于任务数量与工时。">{goal.error ? <ErrorNotice error={goal.error} onRetry={() => void goal.refetch()} /> : goal.isLoading ? <Spinner label="读取主目标" /> : <><strong>{goal.data?.title || '尚未填写主目标'}</strong><p>{goal.data?.detail}</p><Link to={`/app/projects/${projectId}/tasks`}>查看目标与依赖任务</Link></>}</SectionCard>
    </div><div className="stack">{errors.length > 0 && <div className="stack">{errors.map((query, i) => <ErrorNotice key={i} error={query.error} onRetry={() => void query.refetch()} />)}</div>}
    <div className="metric-grid overview-metrics">
      <TaskCompletionMetric variant="overview" completed={done} total={taskItems.length} available={tasks.data !== undefined && !tasks.error} unavailableMessage={tasks.error ? '任务统计暂不可用' : '正在读取任务进度'} />
    </div>
    <SectionCard title="待处理事项" detail="最新两项未完成任务，优先显示由你负责的任务。">
      <div className="card-list">
        {pendingInvitations > 0 && <Link className="list-row attention-row" to={`/app/projects/${projectId}/team`}><span className="attention-mark">{pendingInvitations}</span><span className="list-row-main"><strong>有成员邀请等待批准</strong><p>在团队管理中核对申请，批准后才发送邀请。</p></span><ArrowRight size={15} /></Link>}
        {!tasks.error && <PendingTaskPreview tasks={taskItems} userId={session.data?.id} projectId={projectId} />}
        {missingDeadline && <Link className="list-row attention-row" to={`/app/projects/${projectId}/settings`}><span className="attention-mark">!</span><span className="list-row-main"><strong>截止日期尚未确认</strong><p>项目设置中可记录官方通知中的日期精度。</p></span><ArrowRight size={15} /></Link>}
        {sources.data?.length === 0 && <Link className="list-row attention-row" to={`/app/projects/${projectId}/data?mode=import`}><span className="attention-mark">+</span><span className="list-row-main"><strong>导入通知或项目资料</strong><p>粘贴原文、填写公开网址或上传文件后再提取要求。</p></span><ArrowRight size={15} /></Link>}
        {draftSets !== undefined && draftSets > 0 && <Link className="list-row attention-row" to={`/app/projects/${projectId}/assessment?section=standards`}><span className="attention-mark">{draftSets}</span><span className="list-row-main"><strong>有要求等待纳入统一标准</strong><p>在同一编辑器复核要求与评分维度，确认后固定标准版本。</p></span><ArrowRight size={15} /></Link>}
        {checklistDataReady && !missingDeadline && Boolean(sources.data?.length) && !draftSets && !hasOpenTasks && !pendingInvitations && <EmptyState title="暂无待处理事项" detail="系统没有从当前项目记录中发现待处理内容。" />}
      </div>
    </SectionCard></div></div>
  </div>;
}
