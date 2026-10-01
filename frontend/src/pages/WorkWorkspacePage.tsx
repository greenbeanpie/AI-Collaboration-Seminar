import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listAllItems, projectPath } from '../api/client';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, SectionCard, Spinner } from '../components/ui';
import { TasksPage } from './TasksPage';
import './ProjectWorkspace.css';

export function WorkWorkspacePage() {
  const { projectId } = useProject();
  const requirementsUrl = `/app/projects/${encodeURIComponent(projectId)}/requirements`;
  const requirements = useQuery({ queryKey: ['requirementSets', projectId], queryFn: ({ signal }) => listAllItems<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), {}, { signal }) });
  const rubrics = useQuery({ queryKey: ['rubrics', projectId], queryFn: ({ signal }) => listAllItems<'RubricListResponse'>(projectPath(projectId, '/rubrics'), {}, { signal }) });
  return <div className="page-stack">
    <div className="project-workspace-sections">
      <SectionCard title="项目要求" detail="任务与原文要求相互关联，确认草稿后再按要求推进。" action={<Link className="button button-quiet button-small" to={requirementsUrl}>核对要求</Link>}>
        {requirements.isLoading ? <Spinner label="正在读取项目要求" /> : requirements.error ? <ErrorNotice error={requirements.error} onRetry={() => void requirements.refetch()} /> : requirements.data?.length ? <p>共 {requirements.data.length} 个要求集，{requirements.data.filter(set => set.status === 'confirmed').length} 个已确认。</p> : <EmptyState title="尚未整理项目要求" detail="导入资料后，可提取并人工核对要求。" />}
      </SectionCard>
      <SectionCard title="评分标准" detail="查看已保存的评分版本与确认状态。" action={<Link className="button button-quiet button-small" to={`${requirementsUrl}#rubric-versions`}>查看评分标准</Link>}>
        {rubrics.isLoading ? <Spinner label="正在读取评分标准" /> : rubrics.error ? <ErrorNotice error={rubrics.error} onRetry={() => void rubrics.refetch()} /> : rubrics.data?.length ? <p>共 {rubrics.data.length} 个评分版本，{rubrics.data.filter(rubric => rubric.status === 'confirmed').length} 个已确认。</p> : <EmptyState title="尚未保存评分标准" detail="可依据通知建立官方规则或自拟细则。" />}
      </SectionCard>
    </div>
    <section aria-label="任务看板"><TasksPage /></section>
  </div>;
}
