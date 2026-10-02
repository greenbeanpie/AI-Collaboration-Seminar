import type { ProjectSummary, Task } from '../api/types';

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
