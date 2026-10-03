import { describe, expect, it } from 'vitest';
import type { ProjectSummary, Task } from '../api/types';
import { actionableProjectTasks, pendingProjectGroups, uniqueProjectTasks, deadlineSummary, projectDisplayStatus, remainingDays, deadlineBarStyle } from './dashboard-summary';
const now = new Date(2026, 11, 30, 12);
const task = (dueDate: string | null, status: Task['status'] = 'todo', duePrecision: Task['duePrecision'] = 'date') => ({ dueDate, status, duePrecision, lifecycleState: null }) as Task;
const project = { status: 'active' } as ProjectSummary;
describe('dashboard summaries', () => {
  it('keeps empty, loading and archived projects separate from completed projects', () => {
    expect(projectDisplayStatus(project, undefined)).toBe('unknown');
    expect(projectDisplayStatus(project, [])).toBe('active');
    expect(projectDisplayStatus(project, [task(null, 'done')])).toBe('done');
    expect(projectDisplayStatus(project, [task(null, 'todo')])).toBe('pending');
    expect(projectDisplayStatus({ ...project, status:'archived' }, [task(null, 'done')])).toBe('archived');
  });
  it('handles calendar boundaries, overdue and unknown dates without treating them as today', () => {
    expect(remainingDays(task('2027-01-01'), now)).toBe(2);
    expect(remainingDays(task('2026-12-29'), now)).toBe(-1);
    expect(remainingDays(task('2026-12-30'), now)).toBe(0);
    expect(remainingDays(task('2027-02-30'), now)).toBeNull();
    expect(remainingDays(task('2026-12-30', 'todo', 'unknown'), now)).toBeNull();
    expect(remainingDays(task(null), now)).toBeNull();
  });
  it('counts cumulative reminders and 14+ bins, excluding done, overdue and undated tasks', () => {
    const result = deadlineSummary([task('2026-12-30'),task('2027-01-02'),task('2027-01-06'),task('2027-02-01'),task('2026-12-29'),task(null),task('2026-12-30','done')],now);
    expect(result).toMatchObject({today:1,three:2,seven:3,overdue:1,undated:1});
    expect(result.bins[14]).toBe(1);
    expect(result.bins[11]).toBe(1);
    expect(result.bins[7]).toBe(1);
    expect(result.bins[0]).toBe(1);
    expect(result.bins.reduce((a,b)=>a+b,0)).toBe(4);
  });
  it('keeps today and one day clear while fading monotonically toward fourteen days', () => {
    expect(deadlineBarStyle(0).opacity).toBe(1);
    expect(deadlineBarStyle(1).opacity).toBe(1);
    for(let days=2;days<=14;days++) expect(deadlineBarStyle(days).opacity).toBeLessThan(deadlineBarStyle(days-1).opacity);
  });
});

const assigned = (taskId: string, changes: Partial<Task> = {}): Task => ({ taskId, title: taskId, status: 'doing', lifecycleState: 'in_progress', assigneeId: 'member', revision: 1, dependsOnTaskIds: [], unfinishedDependencyIds: [], dueDate: null, duePrecision: 'unknown', ...changes }) as Task;
const members = [{ userId: 'member' }, { userId: 'another-member' }];
describe('actionable project groups', () => {
  it('counts assigned tasks with no prerequisites and all completed direct prerequisites', () => {
    const rows = [assigned('done', { status: 'done', lifecycleState: 'accepted' }), assigned('plain'), assigned('dependent', { dependsOnTaskIds: ['done', 'done'] }), assigned('other-assignee', { assigneeId: 'another-member' })];
    expect(actionableProjectTasks(rows, members).map(t => t.taskId)).toEqual(['plain', 'dependent', 'other-assignee']);
  });
  it('excludes unassigned, former-member, blocked, submitted, accepted, done and unknown states', () => {
    const rows = [assigned('unassigned', { assigneeId: null }), assigned('former', { assigneeId: 'former-member' }), assigned('blocked', { status: 'blocked' }), assigned('submitted', { lifecycleState: 'submitted' }), assigned('accepted', { lifecycleState: 'accepted' }), assigned('done', { status: 'done' }), assigned('unknown', { lifecycleState: 'waiting' })];
    expect(actionableProjectTasks(rows, members)).toEqual([]);
  });
  it('includes assigned legacy, improved and reworked tasks without treating null as a missing assignee', () => {
    const rows = [assigned('legacy', { lifecycleState: null, status: 'todo' }), assigned('open-assigned', { lifecycleState: 'open' }), assigned('improve', { lifecycleState: 'improve' }), assigned('rework', { lifecycleState: 'rework' })];
    expect(actionableProjectTasks(rows, members)).toHaveLength(4);
  });
  it('does not count unresolved, missing, partially completed or cross-project prerequisite references', () => {
    const rows = [assigned('done', { status: 'done' }), assigned('first'), assigned('second', { dependsOnTaskIds: ['first'] }), assigned('third', { dependsOnTaskIds: ['done', 'second'] }), assigned('missing', { dependsOnTaskIds: ['other-project-task'] }), assigned('server-blocked', { dependsOnTaskIds: ['done'], unfinishedDependencyIds: ['done'] })];
    expect(actionableProjectTasks(rows, members).map(t => t.taskId)).toEqual(['first']);
    expect(actionableProjectTasks(rows.map(t => ['first', 'second'].includes(t.taskId) ? { ...t, status: 'done' } : t), members).map(t => t.taskId)).toEqual(['third']);
  });
  it('uses direct dependency completion like the API, and does not infer readiness from incomplete cached metadata', () => {
    const rows = [assigned('ancestor'), assigned('accepted-before-ancestor', { status: 'done', dependsOnTaskIds: ['ancestor'] }), assigned('ready', { dependsOnTaskIds: ['accepted-before-ancestor'] }), assigned('old-cache', { dependsOnTaskIds: undefined, unfinishedDependencyIds: undefined }), assigned('server-ready', { dependsOnTaskIds: undefined, unfinishedDependencyIds: [] })];
    expect(actionableProjectTasks(rows, members).map(t => t.taskId)).toEqual(['ancestor', 'ready', 'server-ready']);
  });
  it('deduplicates task IDs at their latest revision, retaining distinct deliverables', () => {
    const first = assigned('first');
    const second = assigned('second');
    const rows = [first, first, second, assigned('reassigned'), assigned('reassigned', { revision: 2, assigneeId: null })];
    expect(uniqueProjectTasks(rows)).toHaveLength(3);
    expect(actionableProjectTasks(rows, members).map(t => t.taskId)).toEqual(['first', 'second']);
  });
  it('keeps zero-actionable incomplete projects, excludes empty/completed/archived projects, and totals only displayed actionable tasks', () => {
    const entry = (id: string, tasks: Task[], status = 'active') => ({ project: { id, name: id, status } as ProjectSummary, tasks, members });
    const groups = pendingProjectGroups([entry('ready-project', [assigned('ready'), assigned('ready'), assigned('waiting', { assigneeId: null })]), entry('zero-project', [assigned('blocked', { status: 'blocked' })]), entry('done-project', [assigned('done', { status: 'done' })]), entry('empty-project', []), entry('archived-project', [assigned('archive')], 'archived')]);
    expect(groups.map(g => g.project.id)).toEqual(['ready-project', 'zero-project']);
    expect(groups.map(g => g.actionable.length)).toEqual([1, 0]);
    expect(groups.flatMap(g => g.actionable).map(t => t.taskId)).toEqual(['ready']);
  });
  it('orders project groups and tasks by the next actionable deadline', () => {
    const entry = (id: string, tasks: Task[]) => ({ project: { id, name: id, status: 'active' } as ProjectSummary, tasks, members });
    const dated = (id: string, date: string) => assigned(id, { dueDate: date, duePrecision: 'date' });
    const groups = pendingProjectGroups([entry('later', [dated('late', '2027-02-01')]), entry('sooner', [dated('next', '2027-01-02'), dated('first', '2027-01-01')]), entry('blocked', [dated('unassigned-urgent', '2026-01-01'), assigned('unassigned', { assigneeId: null })].map(t => ({ ...t, assigneeId: null })))]);
    expect(groups.map(g => g.project.id)).toEqual(['sooner', 'later', 'blocked']);
    expect(groups[0].actionable.map(t => t.taskId)).toEqual(['first', 'next']);
  });
});
