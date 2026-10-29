import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTaskFocus, type FocusTask } from './useTaskFocus';
import { projectRequest } from '../../api/simplification';
import { EmptyState, ErrorNotice, Spinner } from '../../components/ui';

export function TaskPin({ projectId, taskId, pinned }: { projectId: string; taskId: string; pinned: boolean }) {
  const client = useQueryClient();
  const pin = useMutation({ mutationFn: () => projectRequest(projectId, `/tasks/${encodeURIComponent(taskId)}/pin`, { method: 'PUT', body: { pinned: !pinned } }), onSuccess: () => client.invalidateQueries({ queryKey: ['task-focus', projectId] }) });
  return <><button type="button" className="button button-quiet button-small" aria-pressed={pinned} disabled={pin.isPending} onClick={() => pin.mutate()}>{pinned ? '取消置顶' : '为我置顶'}</button>{pin.error && <ErrorNotice error={pin.error} />}</>;
}
export function TaskFocus({ projectId, onOpen, compact = false }: { projectId: string; onOpen?: (id: string) => void; compact?: boolean }) {
  const focus = useTaskFocus(projectId);
  const [all, setAll] = useState(false);
  const open = (task: FocusTask) => onOpen ? <button className="collab-title" onClick={() => onOpen(task.taskId)}>{task.title}</button> : <Link to={`/app/projects/${encodeURIComponent(projectId)}/tasks?task=${encodeURIComponent(task.taskId)}`}>{task.title}</Link>;
  return <section className="task-focus stack" aria-label="我现在需要处理"><div className="collab-toolbar"><div><span className="eyebrow">我的下一步</span><h2>我现在需要处理</h2></div>{focus.data && <span>{focus.data.items.length} 项</span>}</div>
    {focus.isLoading && <Spinner label="读取重点任务" />}{focus.error && <ErrorNotice error={focus.error} onRetry={() => void focus.refetch()} />}
    {focus.data && <><div className="task-focus-list">{(all ? focus.data.items : focus.data.items.slice(0, 5)).map(task => <article className="task-focus-item" key={task.taskId}><div className="stack">{open(task)}<div className="chip-list">{task.focusReasons.map(reason => <span className="chip" key={reason}>{reason}</span>)}</div>{task.dueDate && <small>截止：{task.dueDate}</small>}</div>{!compact && <TaskPin projectId={projectId} taskId={task.taskId} pinned={task.pinned} />}</article>)}</div>
      {!focus.data.items.length && <EmptyState title="暂时没有需要你处理的任务" detail="可以查看全部任务，或将关注的任务置顶。" />}
      {focus.data.items.length > 5 && <button className="button button-quiet" onClick={() => setAll(value => !value)}>{all ? '收起重点任务' : `查看全部 ${focus.data.items.length} 项`}</button>}
      {([['等待验收', focus.data.waitingReview], ['待我审核', focus.data.reviewRequired]] as const).map(([label, tasks]) => tasks.length > 0 && <details key={label}><summary>{label} · {tasks.length} 项</summary><ul>{tasks.map(task => <li key={task.taskId}>{open(task)}</li>)}</ul></details>)}
    </>}
  </section>;
}
