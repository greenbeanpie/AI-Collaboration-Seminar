import { describe, expect, it } from 'vitest';
import type { ProjectSummary, Task } from '../api/types';
import { deadlineSummary, projectDisplayStatus, remainingDays, deadlineBarStyle } from './dashboard-summary';
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
