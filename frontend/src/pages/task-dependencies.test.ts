import { expect, it } from 'vitest';
import { dependencyOrder } from './task-dependencies';

it('orders branching dependencies before the final join without counting a main goal', () => {
  const tasks = [{ taskId: 'join', dependsOnTaskIds: ['b', 'c'] }, { taskId: 'c', dependsOnTaskIds: ['a'] }, { taskId: 'b', dependsOnTaskIds: ['a'] }, { taskId: 'a', dependsOnTaskIds: [] }];
  const ordered = dependencyOrder(tasks).map(task => task.taskId);
  expect(ordered).toEqual(['a', 'b', 'c', 'join']);
  expect(tasks[0]?.taskId).toBe('join');
});
it('preserves legacy records and missing historical parents without creating dependency edges', () => {
  const tasks = [{ taskId: 'old', parentTaskId: 'missing', dependsOnTaskIds: [] }, { taskId: 'next', dependsOnTaskIds: ['external'] }];
  expect(dependencyOrder(tasks)).toEqual(tasks);
});
it('does not hide tasks if an older read contains a cycle; the server remains authoritative for writes', () => {
  const tasks = [{ taskId: 'a', dependsOnTaskIds: ['b'] }, { taskId: 'b', dependsOnTaskIds: ['a'] }];
  expect(new Set(dependencyOrder(tasks).map(task => task.taskId))).toEqual(new Set(['a', 'b']));
});
