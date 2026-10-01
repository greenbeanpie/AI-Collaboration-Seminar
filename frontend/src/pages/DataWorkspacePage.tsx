import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listAllItems, projectPath } from '../api/client';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, SectionCard, Spinner, StatusPill } from '../components/ui';
import './ProjectWorkspace.css';

export function DataWorkspacePage() {
  const { projectId } = useProject();
  const root = `/app/projects/${encodeURIComponent(projectId)}`;
  const sources = useQuery({ queryKey: ['sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }) });
  const materials = useQuery({ queryKey: ['materials', projectId], queryFn: () => listAllItems<'MaterialListResponse'>(projectPath(projectId, '/materials'), { limit: 100 }, { requireNextCursor: true }) });
  return <div className="project-workspace-sections">
    <SectionCard title="导入资料" detail="通知、原文、网页与附件。保留证据来源，提取要求前可先检查内容。" action={<Link className="button button-primary button-small" to={`${root}/sources`}>导入或管理资料</Link>}>
      {sources.isLoading ? <Spinner label="正在读取导入资料" /> : sources.error ? <ErrorNotice error={sources.error} onRetry={() => void sources.refetch()} /> : sources.data?.length ? <><p className="project-workspace-count">共 {sources.data.length} 份导入资料</p><ul className="project-workspace-list">{sources.data.slice(0, 5).map(source => <li key={source.sourceId}><Link to={`${root}/sources${source.currentVersionId ? `?sourceVersionId=${encodeURIComponent(source.currentVersionId)}` : ''}#source-${encodeURIComponent(source.sourceId)}`}>{source.title}</Link><StatusPill>{source.currentVersionId ? '已有原文版本' : '待补充原文'}</StatusPill></li>)}</ul>{sources.data.length > 5 && <p className="muted">此处显示前 5 份，进入资料管理查看全部。</p>}</> : <EmptyState title="还没有导入资料" detail="先导入项目通知或参考文件，再核对原文与要求。" />}
    </SectionCard>
    <SectionCard title="成果材料" detail="保存团队成果，复核 AI 草稿并查看各版内容。" action={<Link className="button button-primary button-small" to={`${root}/materials`}>打开成果编辑器</Link>}>
      {materials.isLoading ? <Spinner label="正在读取成果材料" /> : materials.error ? <ErrorNotice error={materials.error} onRetry={() => void materials.refetch()} /> : materials.data?.length ? <><p className="project-workspace-count">共 {materials.data.length} 份成果材料</p><ul className="project-workspace-list">{materials.data.slice(0, 5).map(material => <li key={material.materialId}><span>{material.title}</span><StatusPill tone={material.currentVersionId ? 'good' : 'neutral'}>{material.currentVersionId ? '已有保存版本' : '尚无保存版本'}</StatusPill></li>)}</ul>{materials.data.length > 5 && <p className="muted">此处显示前 5 份，进入成果编辑器查看全部。</p>}</> : <EmptyState title="还没有成果材料" detail="创建成果文档，或使用 AI 协助生成待复核草稿。" />}
      <div className="form-actions"><Link className="button button-quiet button-small" to={`${root}/ai`}>AI 协助成果</Link></div>
    </SectionCard>
  </div>;
}
