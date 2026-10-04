import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import './ProjectNavigation.css';

type Section = { path: string; label: string; aliases?: string[]; ownerOnly?: boolean };
const groups: Array<{ id: string; label: string; sections: Section[] }> = [
  { id: 'overview', label: '概览', sections: [
    { path: '', label: '项目概览' }, { path: 'ledger', label: '活动历史' },
  ] },
  { id: 'work', label: '任务', sections: [
    { path: 'tasks', label: '任务工作区', aliases: ['work'] },
  ] },
  { id: 'data', label: '资料', sections: [
    { path: 'data', label: '项目资料', aliases: ['sources', 'materials', 'ai'] },
  ] },
  { id: 'assessment', label: '评分', sections: [
    { path: 'assessment', label: '标准与评分', aliases: ['requirements', 'reviews', 'rehearsals'] },
  ] },
  { id: 'team', label: '团队', sections: [
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

export function ProjectSectionNavigation({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const navigate = useNavigate();
  const { current, destination, sectionMatches } = useProjectNavigation(projectId);
  if (current.id === 'assessment') return <AssessmentSubmenu projectId={projectId} />;
  const sections = current.sections.filter(section => !section.ownerOnly || canManage);
  if (sections.length < 2) return null;
  const selected = sections.find(sectionMatches)?.path ?? sections[0]!.path;
  return <nav className="project-content-navigation project-section-navigation" aria-label={`${current.label}分区`}>
    <div className="project-content-links project-section-links">{sections.map(section => <Link key={section.path} to={destination(section.path)} aria-current={sectionMatches(section) ? 'page' : undefined} className={`project-tab project-section-link ${sectionMatches(section) ? 'active' : ''}`}>{section.label}</Link>)}</div>
    <select className="input project-content-select" aria-label={`切换${current.label}分区`} value={selected} onChange={event => navigate(destination(event.target.value))}>
      {sections.map(section => <option key={section.path} value={section.path}>{section.label}</option>)}
    </select>
  </nav>;
}

function AssessmentSubmenu({ projectId }: { projectId: string }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(search).get('section');
  const selected = ['standards', 'checks', 'rehearsals'].includes(requested ?? '') ? requested! : pathname.endsWith('/reviews') ? 'checks' : pathname.endsWith('/rehearsals') ? 'rehearsals' : 'standards';
  const items = [['standards', '项目标准'], ['checks', '材料检查'], ['rehearsals', '答辩演练']];
  const destination = (section: string) => `/app/projects/${encodeURIComponent(projectId)}/assessment?section=${section}`;
  return <nav className="project-content-navigation project-section-navigation" aria-label="评分分区"><div className="project-content-links project-section-links">{items.map(([section, label]) => <Link key={section} to={destination(section)} aria-current={selected === section ? 'page' : undefined} className={`project-tab project-section-link ${selected === section ? 'active' : ''}`}>{label}</Link>)}</div><select className="input project-content-select" aria-label="切换评分分区" value={selected} onChange={event => navigate(destination(event.target.value))}>{items.map(([section, label]) => <option key={section} value={section}>{label}</option>)}</select></nav>;
}

export function ProjectSectionLayout({ children }: { projectId: string; children: ReactNode }) {
  return <div className="project-section-layout">
    {children}
  </div>;
}
