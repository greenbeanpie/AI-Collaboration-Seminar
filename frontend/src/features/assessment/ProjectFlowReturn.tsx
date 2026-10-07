import { projectReturnPath } from './project-return-path';
import { Link, useSearchParams } from 'react-router-dom';
import { useProject } from '../../components/ProjectShell';

export function ProjectFlowReturn() {
  const { projectId } = useProject();
  const [params] = useSearchParams();
  const to = projectReturnPath(params.get('returnTo'), projectId);
  return to ? <Link className="button button-quiet" to={to}>已完成补齐，返回原操作</Link> : null;
}
