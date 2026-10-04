import type { Member, ProjectSummary, Task } from '../api/types';

/** A task is counted once per project; legacy parent tasks remain separate deliverables. */
export function uniqueProjectTasks(tasks: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    const existing = byId.get(task.taskId);
    if (!existing || task.revision > existing.revision) byId.set(task.taskId, task);
  }
  return [...byId.values()];
}

export function actionableProjectTasks(tasks: readonly Task[], members: readonly Pick<Member, 'userId'>[]): Task[] {
  const unique = uniqueProjectTasks(tasks);
  const byId = new Map(unique.map(task => [task.taskId, task]));
  const memberIds = new Set(members.map(member => member.userId));
  return unique.filter(task => {
    if (!task.assigneeId || !memberIds.has(task.assigneeId) || !['todo', 'doing'].includes(task.status)) return false;
    // Submitted tasks await review; unknown future states must not be presented as ready.
    if (task.lifecycleState && !['open', 'in_progress', 'improve', 'rework'].includes(task.lifecycleState)) return false;
    if (task.unfinishedDependencyIds?.length) return false;
    // Old cache entries may lack dependency metadata. Do not guess that they have no prerequisites.
    if (!task.dependsOnTaskIds) return task.unfinishedDependencyIds?.length === 0;
    // Match the API's direct-dependency semantics, using only this project's authorized records.
    return task.dependsOnTaskIds.every(id => byId.get(id)?.status === 'done');
  });
}

export function pendingProjectGroups(entries: readonly { project: ProjectSummary; tasks?: readonly Task[]; members?: readonly Pick<Member, 'userId'>[] }[]) {
  return entries.filter(entry => entry.project.status !== 'archived').flatMap(({ project, tasks, members }) => {
    const unique = uniqueProjectTasks(tasks ?? []);
    if (!unique.some(task => task.status !== 'done')) return [];
    const actionable = actionableProjectTasks(unique, members ?? []).sort((a, b) => (remainingDays(a) ?? Infinity) - (remainingDays(b) ?? Infinity) || a.taskId.localeCompare(b.taskId));
    return actionable.length ? [{ project, actionable }] : [];
  }).sort((a, b) => (a.actionable[0] ? remainingDays(a.actionable[0]) ?? Infinity : Infinity) - (b.actionable[0] ? remainingDays(b.actionable[0]) ?? Infinity : Infinity) || a.project.name.localeCompare(b.project.name) || a.project.id.localeCompare(b.project.id));
}

export type ProjectDisplayStatus = 'pending' | 'active' | 'done' | 'archived' | 'unknown';
export function projectDisplayStatus(project: ProjectSummary, tasks: readonly Task[] | undefined): ProjectDisplayStatus {
  if (project.status === 'archived') return 'archived';
  if (!tasks) return 'unknown';
  if (tasks?.length && tasks.every(task => task.status === 'done')) return 'done';
  if (tasks?.some(task => task.status === 'todo' || task.status === 'blocked' || task.lifecycleState === 'submitted')) return 'pending';
  return 'active';
}

export function remainingDays(task: Pick<Task, 'dueDate' | 'duePrecision'>, now = new Date()): number | null {
  const value = task.dueDate;
  if (task.duePrecision === 'unknown' || !value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return (parsed - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000;
}

export function deadlineSummary(tasks: readonly Task[], now = new Date()) {
  const bins = Array<number>(15).fill(0);
  let today = 0, three = 0, seven = 0, overdue = 0, undated = 0;
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const days = remainingDays(task, now);
    if (days === null) { undated++; continue; }
    if (days < 0) { overdue++; continue; }
    bins[14 - Math.min(14, days)]++;
    if (days === 0) today++;
    if (days <= 3) three++;
    if (days <= 7) seven++;
  }
  return { bins, today, three, seven, overdue, undated };
}

export function deadlineBarStyle(days: number) {
  const stops = [{ day: 0, color: [214, 69, 69] }, { day: 3, color: [234, 115, 35] }, { day: 7, color: [47, 107, 255] }, { day: 14, color: [181, 212, 244] }];
  const upper = stops.findIndex(stop => stop.day >= days);
  const high = stops[Math.max(1, upper)], low = stops[Math.max(0, upper - 1)];
  const ratio = (days - low.day) / (high.day - low.day);
  const color = low.color.map((channel, index) => Math.round(channel + (high.color[index] - channel) * ratio));
  return { backgroundColor: `rgb(${color.join(', ')})`, opacity: days <= 1 ? 1 : 1 - .94 * Math.log(days) / Math.log(14) };
}
