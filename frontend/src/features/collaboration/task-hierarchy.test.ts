import { describe, expect, it } from 'vitest';
import { taskAncestors, taskTreeRows } from './task-hierarchy';

const tasks = [
  { taskId: 'root', title: '交付', parentTaskId: null, dependsOnTaskIds: ['child'] },
  { taskId: 'child', title: '研究', parentTaskId: 'root' },
  { taskId: 'leaf', title: '访谈', parentTaskId: 'child' },
  { taskId: 'other', title: '校对', parentTaskId: null, dependsOnTaskIds: ['child'] },
];
describe('task hierarchy presentation', () => {
  it('keeps dependency links separate from parentage', () => {
    const rows = taskTreeRows(tasks, () => true, new Set(), false);
    expect(rows.map(row => [row.task.taskId, row.depth])).toEqual([['root', 0], ['child', 1], ['leaf', 2], ['other', 0]]);
  });
  it('keeps ancestor context for matches even when ancestors are collapsed', () => {
    const rows = taskTreeRows(tasks, task => task.taskId === 'leaf', new Set(['root']), true);
    expect(rows.map(row => [row.task.taskId, row.contextOnly])).toEqual([['root', true], ['child', true], ['leaf', false]]);
  });
  it('collapses descendants but retains unrelated downstream tasks', () => {
    expect(taskTreeRows(tasks, () => true, new Set(['root']), false).map(row => row.task.taskId)).toEqual(['root', 'other']);
  });
  it('does not loop with a malformed cycle and keeps orphan tasks visible', () => {
    const cycle = [{ taskId: 'a', title: 'A', parentTaskId: 'b' }, { taskId: 'b', title: 'B', parentTaskId: 'a' }];
    expect(taskAncestors(cycle[0]!, cycle)).toHaveLength(1);
    expect(taskTreeRows(cycle, () => true, new Set(), false)).toHaveLength(2);
    expect(taskTreeRows([{ taskId: 'orphan', title: 'C', parentTaskId: 'missing' }], () => true, new Set(), false)[0]?.depth).toBe(0);
  });
});
