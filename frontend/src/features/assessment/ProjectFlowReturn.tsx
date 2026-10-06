import { Link, useSearchParams } from 'react-router-dom';
import { useProject } from '../../components/ProjectShell';

export function projectReturnPath(value: string | null, projectId: string): string | null {
  if (!value || /[\\\r\n]/.test(value)) return null;
  const prefix = `/app/projects/${encodeURIComponent(projectId)}/`;
  try {
    const url = new URL(value, 'https://project.invalid');
    if (url.origin !== 'https://project.invalid' || !url.pathname.startsWith(prefix) || value.startsWith('//')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}
export function ProjectFlowReturn() {
  const { projectId } = useProject();
  const [params] = useSearchParams();
  const to = projectReturnPath(params.get('returnTo'), projectId);
  return to ? <Link className="button button-quiet" to={to}>已完成补齐，返回原操作</Link> : null;
}
