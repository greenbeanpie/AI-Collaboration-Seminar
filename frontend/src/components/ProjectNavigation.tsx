import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import './ProjectNavigation.css';

type Section = { path: string; label: string; aliases?: string[]; ownerOnly?: boolean };
const groups: Array<{ id: string; label: string; detail: string; sections: Section[] }> = [
  { id: 'overview', label: '概览', detail: '查看项目进度与活动历史。', sections: [
    { path: '', label: '项目概览' }, { path: 'ledger', label: '活动历史' },
  ] },
  { id: 'work', label: '任务', detail: '围绕一个主目标安排子任务，前置依赖帮助团队确定推进顺序。', sections: [
    { path: 'tasks', label: '任务工作区', aliases: ['work'] },
  ] },
  { id: 'data', label: '资料', detail: '在同一工作区管理背景、参考资料和成果，保留原文与版本。', sections: [
    { path: 'data', label: '项目资料', aliases: ['sources', 'materials', 'ai'] },
  ] },
  { id: 'assessment', label: '评分', detail: '统一维护项目标准，通过材料检查或答辩演练评价主目标。', sections: [
    { path: 'assessment', label: '标准与评分', aliases: ['requirements', 'reviews', 'rehearsals'] },
  ] },
  { id: 'team', label: '团队', detail: '管理成员、角色、邀请和任务负荷。', sections: [
    { path: 'team', label: '团队成员' }, { path: 'settings', label: '团队设置', ownerOnly: true }, { path: 'export', label: '导出' },
  ] },
];

function useProjectNavigation(projectId: string) {
  const { pathname } = useLocation();
  const root = `/app/projects/${encodeURIComponent(projectId)}`;
  const destination = (path: string) => path ? `${root}/${path}` : root;
  const matches = (path: string) => pathname.replace(/\/$/, '') === destination(path) || Boolean(path && pathname.startsWith(`${destination(path)}/`));
  const sectionMatches = (section: Section) => [section.path, ...(section.aliases ?? [])].some(matches);
  const current = groups.find(group => group.sections.some(sectionMatches)) ?? groups[0]!;
  return { current, destination, sectionMatches };
}

/** Existing URLs still use the router, including its draft blockers and Back/Forward history. */
export function ProjectNavigation({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { current, destination } = useProjectNavigation(projectId);
  return <nav className="project-content-navigation project-group-navigation" aria-label="项目功能" data-testid="project-tabs">
    <div className="project-content-links">{groups.map(group => <Link key={group.id} to={destination(group.sections[0]!.path)} aria-current={current.id === group.id ? 'page' : undefined} className={`project-tab ${current.id === group.id ? 'active' : ''}`}>{group.label}</Link>)}</div>
    <select className="input project-content-select" aria-label="切换项目功能" value={current.id} onChange={event => {
      const group = groups.find(item => item.id === event.target.value);
      if (group) navigate(destination(group.sections[0]!.path));
    }}>
      {groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
    </select>
  </nav>;
}

export function ProjectSectionLayout({ projectId, canManage, children }: { projectId: string; canManage: boolean; children: ReactNode }) {
  const { current, destination, sectionMatches } = useProjectNavigation(projectId);
  const visibleSections = current.sections.filter(section => !section.ownerOnly || canManage);
  if (visibleSections.length === 1) return <>{children}</>;
  return <div className="project-section-layout">
    <div className="project-section-heading"><h2>{current.label}</h2><p>{current.detail}</p></div>
    <nav className="project-section-links" aria-label={`${current.label}分区`}>{visibleSections.map(section => <Link key={section.path} to={destination(section.path)} aria-current={sectionMatches(section) ? 'page' : undefined} className={`project-section-link ${sectionMatches(section) ? 'active' : ''}`}>{section.label}</Link>)}</nav>
    {children}
  </div>;
}
