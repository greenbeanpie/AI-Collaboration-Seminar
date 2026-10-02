import { expect, it } from 'vitest';
import type { Task } from '../api/types';
import { latestPendingTasks } from './pending-tasks';
function task(id: string, createdAt: string, assigneeId: string | null = null, status: Task['status'] = 'todo'): Task {
  return { taskId: id, lifecycleState: null, criteria: '', effortHours: 0, parentTaskId: null, currentSubmissionId: null, citations: [], dependsOnTaskIds: [], unfinishedDependencyIds: [], title: id, detail: '', createdAt, updatedAt: createdAt, assigneeId, status, dueDate: null, duePrecision: 'unknown', requirementId: null, revision: 1 };
}
it('handles empty and one task without adding fabricated records', () => {
  expect(latestPendingTasks([], 'me')).toEqual([]);
  const one = task('one', '2026-10-01T00:00:00Z');
  expect(latestPendingTasks([one], 'me')).toEqual([one]);
});
it('prioritizes my latest two open tasks over newer team tasks and excludes done', () => {
  const tasks = [task('team-new', '2026-10-09T00:00:00Z', 'other'), task('mine-old', '2026-10-01T00:00:00Z', 'me'), task('mine-new', '2026-10-03T00:00:00Z', 'me'), task('mine-middle', '2026-10-02T00:00:00Z', 'me', 'blocked'), task('done', '2026-10-10T00:00:00Z', 'me', 'done')];
  expect(latestPendingTasks(tasks, 'me').map(t => t.taskId)).toEqual(['mine-new', 'mine-middle']);
  expect(tasks[0].taskId).toBe('team-new'); // Do not mutate React Query's cache.
});
it('uses actual creation time and stable ID ties, and fills remaining slot from the team', () => {
  const tasks = [task('mine', '2026-09-01T00:00:00Z', 'me'), task('b', '2026-10-01T08:00:00+08:00'), task('a', '2026-10-01T00:00:00Z'), task('old', '2026-09-30T23:59:59Z')];
  expect(latestPendingTasks(tasks, 'me').map(t => t.taskId)).toEqual(['mine', 'a']);
  expect(latestPendingTasks(tasks, undefined).map(t => t.taskId)).toEqual(['a', 'b']);
});
