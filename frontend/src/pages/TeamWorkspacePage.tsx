import { Link } from 'react-router-dom';
import { useProject } from '../components/ProjectShell';
import { SectionCard } from '../components/ui';
import { TeamPage } from './TeamPage';
import './ProjectWorkspace.css';

export function TeamWorkspacePage() {
  const { projectId, project } = useProject();
  const root = `/app/projects/${encodeURIComponent(projectId)}`;
  return <div className="page-stack">
    <div className="project-workspace-sections">
      {project.myRole === 'owner' && <SectionCard title="团队设置" detail="维护项目信息、截止日期与团队协作方式。">
        <p className="muted">由项目负责人调整项目名称、说明、截止日期及协作方式。</p><Link className="button button-quiet" to={`${root}/settings`}>打开团队设置</Link>
      </SectionCard>}
      <SectionCard title="导出" detail="整理当前成果、要求、任务与过程记录。">
        <p className="muted">选择所需格式，下载当前项目的整理记录。</p><Link className="button button-quiet" to={`${root}/export`}>打开项目导出</Link>
      </SectionCard>
    </div>
    <section aria-label="团队成员与协作"><TeamPage /></section>
  </div>;
}
