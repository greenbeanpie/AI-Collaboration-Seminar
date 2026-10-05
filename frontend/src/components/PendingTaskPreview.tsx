import { AiReferenceBadge } from './AiReferenceBadge';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { Task } from '../api/types';
import { latestPendingTasks } from '../pages/pending-tasks';

const labels = { todo: '待开始', doing: '进行中', blocked: '受阻', done: '已完成' };
export function PendingTaskPreview({ tasks, userId, projectId }: { tasks: readonly Task[]; userId: string | undefined; projectId: string }) {
  return <>{latestPendingTasks(tasks, userId).map(task => <Link key={task.taskId} className="list-row attention-row" to={`/app/projects/${encodeURIComponent(projectId)}/tasks?task=${encodeURIComponent(task.taskId)}`}>
    <span className="attention-mark">{task.assigneeId === userId ? '我' : '→'}</span>
    <span className="list-row-main"><strong>{task.title}<AiReferenceBadge ariaHidden /></strong><p>{task.assigneeId === userId ? '由你负责 · ' : ''}{labels[task.status]}{task.dueDate ? ` · 截止 ${task.dueDate}` : ''}</p></span><ArrowRight size={15} />
  </Link>)}</>;
}
