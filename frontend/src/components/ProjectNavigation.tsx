import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import './ProjectNavigation.css';

type Section = { path: string; label: string; aliases?: string[]; ownerOnly?: boolean };
const groups: Array<{ id: string; label: string; detail: string; sections: Section[] }> = [
  { id: 'overview', label: '概览', detail: '查看项目进度与活动历史。', sections: [
    { path: '', label: '项目概览' }, { path: 'ledger', label: '活动历史' },
  ] },
  { id: 'work', label: '要求与任务', detail: '先核对要求与评分，再拆解、分配和跟进任务。', sections: [
    { path: 'work', label: '任务看板', aliases: ['tasks'] }, { path: 'requirements', label: '要求与评分' },
  ] },
  { id: 'data', label: '资料', detail: '导入资料保留通知、原文和附件；成果材料用于编辑文档、草稿与版本。', sections: [
    { path: 'data', label: '资料总览' }, { path: 'sources', label: '导入资料' }, { path: 'materials', label: '成果材料', aliases: ['ai'] },
  ] },
  { id: 'team', label: '团队', detail: '管理成员、团队设置与项目导出。', sections: [
    { path: 'team', label: '团队成员' }, { path: 'settings', label: '团队设置', ownerOnly: true }, { path: 'export', label: '导出' },
  ] },
  { id: 'checks', label: '检查与演练', detail: '检查成果是否符合要求，再准备答辩与演练。', sections: [
    { path: 'reviews', label: '成果检查' }, { path: 'rehearsals', label: '答辩演练' },
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
  const sections = current.sections.filter(section => !section.ownerOnly || canManage);
  const selected = sections.find(sectionMatches)?.path ?? sections[0]!.path;
  return <nav className="project-content-navigation project-section-navigation" aria-label={`${current.label}分区`}>
    <div className="project-content-links project-section-links">{sections.map(section => <Link key={section.path} to={destination(section.path)} aria-current={sectionMatches(section) ? 'page' : undefined} className={`project-tab project-section-link ${sectionMatches(section) ? 'active' : ''}`}>{section.label}</Link>)}</div>
    <select className="input project-content-select" aria-label={`切换${current.label}分区`} value={selected} onChange={event => navigate(destination(event.target.value))}>
      {sections.map(section => <option key={section.path} value={section.path}>{section.label}</option>)}
    </select>
  </nav>;
}

export function ProjectSectionLayout({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { current } = useProjectNavigation(projectId);
  return <div className="project-section-layout">
    <div className="project-section-heading"><h2>{current.label}</h2><p>{current.detail}</p></div>
    {children}
  </div>;
}
