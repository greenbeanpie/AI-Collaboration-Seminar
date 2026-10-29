import { taskAncestors, type HierarchyTask } from './task-hierarchy';

export function TaskRelationships({ task, tasks, onOpen, detail = false }: { task: HierarchyTask; tasks: readonly HierarchyTask[]; onOpen: (id: string) => void; detail?: boolean }) {
  const ancestors = taskAncestors(task, tasks);
  const children = tasks.filter(row => row.parentTaskId === task.taskId);
  const downstream = tasks.filter(row => row.dependsOnTaskIds?.includes(task.taskId));
  const link = (id: string) => <button type="button" className="task-relation-link" onClick={() => onOpen(id)}>{tasks.find(row => row.taskId === id)?.title ?? '暂不可见的任务'}</button>;
  return <div className="task-relationships">
    {ancestors.length > 0 && <div aria-label="父任务路径">父任务：{ancestors.map((row, index) => <span key={row.taskId}>{index > 0 && ' / '}{link(row.taskId)}</span>)}</div>}
    {(task.dependsOnTaskIds?.length ?? 0) > 0 && <div>前置：{task.dependsOnTaskIds!.map(id => <span key={id}>{link(id)}<small>（{tasks.find(row => row.taskId === id)?.status === 'done' ? '已完成' : '未完成或状态待确认'}）</small> </span>)}</div>}
    {downstream.length > 0 && <div>后续：{downstream.map(row => <span key={row.taskId}>{link(row.taskId)} </span>)}</div>}
    {detail && children.length > 0 && <div>子任务 · 已完成 {children.filter(row => row.status === 'done').length}/{children.length}：{children.map(row => <span key={row.taskId}>{link(row.taskId)} </span>)}</div>}
  </div>;
}
