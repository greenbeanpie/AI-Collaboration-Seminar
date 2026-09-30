import { createContext, useContext } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import type { Project } from '../api/types';
import { ErrorNotice, Spinner, StatusPill } from './ui';

type ProjectContextValue = { projectId: string; project: Project };
const ProjectContext = createContext<ProjectContextValue | null>(null);
export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('Project page must be inside ProjectShell');
  return value;
}

const tabs = [
  ['overview', '概览'], ['sources', '通知来源'], ['requirements', '要求与评分'], ['team', '团队'], ['tasks', '任务'],
  ['ai', 'AI 工作区'], ['materials', '材料中心'], ['reviews', '预审'], ['rehearsals', '答辩演练'],
  ['ledger', '过程账本'], ['settings', '项目设置'], ['export', '导出'],
] as const;

export function ProjectShell() {
  const { projectId = '' } = useParams();
  const query = useQuery({ queryKey: ['project', projectId], queryFn: () => api.get<'ProjectResponse'>(projectPath(projectId)) });
  if (query.isLoading) return <div className="content-wrap"><Spinner label="正在读取项目" /></div>;
  if (query.error) return <div className="content-wrap"><ErrorNotice error={query.error} onRetry={() => void query.refetch()} /></div>;
  if (!query.data) return null;
  const project = query.data;
  return <ProjectContext.Provider value={{ projectId, project }}>
    <div className="project-banner"><div className="project-breadcrumb"><NavLink to="/app">我的项目</NavLink><span>/</span><span>{project.name}</span></div><div className="project-name-row"><div><h1>{project.name}</h1><p>{project.description || '项目空间与协作进度'}</p></div><StatusPill tone={project.status === 'active' ? 'good' : 'neutral'}>{project.status === 'active' ? '进行中' : '已归档'}</StatusPill></div></div>
    <nav className="project-tabs" aria-label="项目功能" data-testid="project-tabs">{tabs.map(([path, label]) => <NavLink key={path} end={path === 'overview'} to={path === 'overview' ? `/app/projects/${projectId}` : `/app/projects/${projectId}/${path}`} className={({ isActive }) => `project-tab ${isActive ? 'active' : ''}`}>{label}</NavLink>)}</nav>
    <div className="content-wrap"><Outlet /></div>
  </ProjectContext.Provider>;
}
