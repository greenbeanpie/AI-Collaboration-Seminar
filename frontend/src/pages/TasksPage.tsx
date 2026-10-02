import { PageHeading } from '../components/ui';
import { CollaborationWorkspace } from './CollaborationWorkspace';
import './TasksMaterials.css';

export function TasksPage() {
  return <div className="page-stack tm-page tm-tasks-page">
    <PageHeading title="任务工作区" detail="一个主目标，下设有依赖关系的子任务；认领、分工、提交和验收都在同一处完成。" />
    <CollaborationWorkspace />
  </div>;
}
