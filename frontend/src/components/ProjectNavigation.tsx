import { NavLink, useLocation, useNavigate } from 'react-router-dom';

const tabs = [
  ['overview', '概览'], ['sources', '通知来源'], ['requirements', '要求与评分'], ['team', '团队'], ['tasks', '任务'],
  ['ai', 'AI 工作区'], ['materials', '材料中心'], ['reviews', '预审'], ['rehearsals', '答辩演练'],
  ['ledger', '过程账本'], ['settings', '项目设置'], ['export', '导出'],
] as const;

/** Project navigation belongs to the project content, separate from global account controls. */
export function ProjectNavigation({ projectId }: { projectId: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const root = `/app/projects/${encodeURIComponent(projectId)}`;
  const current = tabs.find(([path]) => path !== 'overview' && (pathname === `${root}/${path}` || pathname.startsWith(`${root}/${path}/`)))?.[0] ?? 'overview';
  const destination = (path: string) => path === 'overview' ? root : `${root}/${path}`;
  return <nav className="project-content-navigation" aria-label="项目功能" data-testid="project-tabs">
    <div className="project-content-links">{tabs.map(([path, label]) => <NavLink key={path} end={path === 'overview'} to={destination(path)} className={({ isActive }) => `project-tab ${isActive ? 'active' : ''}`}>{label}</NavLink>)}</div>
    <select className="input project-content-select" aria-label="切换项目功能" value={current} onChange={event => navigate(destination(event.target.value))}>
      {tabs.map(([path, label]) => <option key={path} value={path}>{label}</option>)}
    </select>
  </nav>;
}
