import { AiReferenceBadge } from './AiReferenceBadge';
import { createContext, useContext, Suspense, useState, lazy } from 'react';
import { ProjectNavigation, ProjectSectionLayout, ProjectSectionNavigation } from './ProjectNavigation';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import type { Project } from '../api/types';
import { ErrorNotice, Spinner, StatusPill } from './ui';
import { isDesktop } from '../desktop/bridge';

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
  const query = useQuery({ queryKey: ['project', projectId], queryFn: () => api.get<'ProjectResponse'>(projectPath(projectId)) });
  if (query.isLoading) return <div className="content-wrap"><Spinner label="正在读取项目" /></div>;
  if (query.error) return <div className="content-wrap"><ErrorNotice error={query.error} onRetry={() => void query.refetch()} /></div>;
  if (!query.data) return null;
  const project = query.data;
  return <ProjectContext.Provider value={{ projectId, project }}>
    <div className="project-banner"><div className="project-breadcrumb"><NavLink to="/app">我的项目</NavLink><span>/</span><span>{project.name}</span></div><div className="project-name-row"><div><h1>{project.name}<AiReferenceBadge ariaHidden /></h1><p>{project.description || '项目空间与协作进度'}{project.description && <AiReferenceBadge ariaHidden />}</p></div><StatusPill tone={project.status === 'active' ? 'good' : 'neutral'}>{project.status === 'active' ? '进行中' : '已归档'}</StatusPill></div></div>
    <ProjectNavigation projectId={projectId} />
    {isDesktop() && <div className="content-wrap"><button type="button" className="button button-quiet button-small" aria-expanded={localFilesOpen} onClick={() => setLocalFilesOpen(open => !open)}>本机离线文件</button>{localFilesOpen && <Suspense fallback={<Spinner label="读取本机文件" />}><DesktopFilesPanel key={projectId} projectId={projectId} /></Suspense>}</div>}
    <ProjectSectionNavigation projectId={projectId} canManage={project.myRole === 'owner'} />
    <div className="content-wrap project-content-wrap"><ProjectSectionLayout projectId={projectId}><Suspense fallback={<Spinner label="正在打开项目内容" />}><Outlet /></Suspense></ProjectSectionLayout></div>
  </ProjectContext.Provider>;
}
