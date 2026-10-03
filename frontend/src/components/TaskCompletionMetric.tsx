import { CircleCheck } from 'lucide-react';
import { taskCompletion } from './task-completion';
import './TaskCompletionMetric.css';

type Props = {
  completed: number;
  total: number;
  variant: 'dashboard' | 'overview';
  available: boolean;
  unavailableMessage: string;
};

export function TaskCompletionMetric({ completed, total, variant, available, unavailableMessage }: Props) {
  const progress = taskCompletion(completed, total);
  const dashboard = variant === 'dashboard';
  const label = dashboard ? '任务完成率' : '任务完成';
  return <div className={`${dashboard ? 'dashboard-metric' : 'metric-card'} task-completion-card`} data-completion-tone={available ? progress.tone : undefined}>
    <span className={dashboard ? 'dashboard-metric-label' : undefined}>{dashboard && <CircleCheck size={16} aria-hidden="true" />}{label}</span>
    <strong className={dashboard ? 'dashboard-metric-value' : undefined}>
      {available ? dashboard ? progress.percent : `${progress.completed}/${progress.total}` : '—'}{dashboard && <small>%</small>}
    </strong>
    {available && <div className="task-completion-progress">
      {!dashboard && <div className="task-completion-caption"><span>完成率</span><strong>{progress.percent}%</strong></div>}
      <div className="task-completion-track" role="progressbar" aria-label="任务完成率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={`${progress.percent}%，${progress.total === 0 ? '暂无任务' : `${progress.completed} / ${progress.total} 项任务已完成`}`}>
        <span style={{ width: `${progress.ratio}%` }} />
      </div>
    </div>}
    <small className={dashboard ? 'dashboard-metric-foot' : undefined}>
      {!available ? unavailableMessage : dashboard ? `${progress.completed} / ${progress.total} 项任务已完成` : progress.total === 0 ? '暂无任务' : '按服务端任务状态计算'}
    </small>
  </div>;
}
