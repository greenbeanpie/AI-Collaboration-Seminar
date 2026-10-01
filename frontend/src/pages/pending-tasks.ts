import type { Task } from '../api/types';

/** Rank only the caller's already-authorized project task list; never fetch across projects. */
export function latestPendingTasks(tasks: readonly Task[], userId: string | undefined): Task[] {
  const mine = (task: Task) => userId !== undefined && task.assigneeId === userId ? 1 : 0;
  const time = (task: Task) => Number.isFinite(Date.parse(task.createdAt)) ? Date.parse(task.createdAt) : 0;
  return tasks.filter(task => task.status !== 'done').sort((a, b) =>
    mine(b) - mine(a) || time(b) - time(a) || a.taskId.localeCompare(b.taskId),
  ).slice(0, 2);
}
