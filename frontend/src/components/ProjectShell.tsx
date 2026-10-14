import { AiReferenceBadge } from './AiReferenceBadge';
import { createContext, useContext, Suspense, useState, useEffect, lazy } from 'react';
import { ProjectNavigation, ProjectSectionLayout, ProjectSectionNavigation } from './ProjectNavigation';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import type { Project } from '../api/types';
import { ErrorNotice, Spinner, StatusPill } from './ui';
import { isDesktop } from '../desktop/bridge';
import { offlineAccount, projectRevoked } from '../offline/store';
import { ResourceUsageNotice } from './ResourceUsageNotice';
import { RetainedProjectDrafts } from './RetainedProjectDrafts';

const DesktopFilesPanel = lazy(() => import('../desktop/DesktopFilesPanel').then(module => ({ default: module.DesktopFilesPanel })));

type ProjectContextValue = { projectId: string; project: Project };
const ProjectContext = createContext<ProjectContextValue | null>(null);
export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('Project page must be inside ProjectShell');
  return value;
}

export function ProjectShell() {
  const { projectId = '' } = useParams();
  const [localFilesOpen, setLocalFilesOpen] = useState(false);
  const [revoked, setRevoked] = useState(() => Boolean(offlineAccount()?.id && projectRevoked(offlineAccount()!.id, projectId)));
  useEffect(() => {
    const refresh = () => { const accountId = offlineAccount()?.id; setRevoked(Boolean(accountId && projectRevoked(accountId, projectId))); };
    refresh();
    window.addEventListener('project-access-revoked', refresh); window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('project-access-revoked', refresh); window.removeEventListener('storage', refresh); };
  }, [projectId]);
  const query = useQuery({ queryKey: ['project', projectId], queryFn: () => api.get<'ProjectResponse'>(projectPath(projectId)), enabled: !revoked });
  if (revoked) return <div className="content-wrap"><section className="card"><h1>项目权限已变更</h1><p>原项目快照已停止显示。本机草稿和待同步修改仍保留，可从上方同步记录导出或明确放弃。</p><button className="button button-quiet" disabled={query.isFetching || !navigator.onLine} onClick={() => void query.refetch().then(result => { if (result.isSuccess) setRevoked(false); })}>联网核对项目权限</button><NavLink to="/app">返回我的项目</NavLink>{offlineAccount()?.id && <RetainedProjectDrafts key={`${offlineAccount()!.id}:${projectId}`} accountId={offlineAccount()!.id} projectId={projectId} />}</section></div>;
  if (query.isLoading) return <div className="content-wrap"><Spinner label="正在读取项目" /></div>;
  if (query.error) return <div className="content-wrap"><ErrorNotice error={query.error} onRetry={() => void query.refetch()} /></div>;
  if (!query.data) return null;
  const project = query.data;
  return <ProjectContext.Provider value={{ projectId, project }}>
    <div className="project-banner"><div className="project-breadcrumb"><NavLink to="/app">我的项目</NavLink><span>/</span><span>{project.name}</span></div><div className="project-name-row"><div><h1>{project.name}<AiReferenceBadge ariaHidden /></h1><p>{project.description || '项目空间与协作进度'}{project.description && <AiReferenceBadge ariaHidden />}</p></div><StatusPill tone={project.status === 'active' ? 'good' : 'neutral'}>{project.status === 'active' ? '进行中' : '已归档'}</StatusPill></div></div>
    <ProjectNavigation projectId={projectId} />
    <div className="content-wrap"><ResourceUsageNotice projectId={projectId} /></div>
    {isDesktop() && <div className="content-wrap"><button type="button" className="button button-quiet button-small" aria-expanded={localFilesOpen} onClick={() => setLocalFilesOpen(open => !open)}>本机离线文件</button>{localFilesOpen && <Suspense fallback={<Spinner label="读取本机文件" />}><DesktopFilesPanel key={projectId} projectId={projectId} /></Suspense>}</div>}
    <ProjectSectionNavigation projectId={projectId} canManage={project.myRole === 'owner'} />
    <div className="content-wrap project-content-wrap"><ProjectSectionLayout projectId={projectId}><Suspense fallback={<Spinner label="正在打开项目内容" />}><Outlet /></Suspense></ProjectSectionLayout></div>
  </ProjectContext.Provider>;
}
