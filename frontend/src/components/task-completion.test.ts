import { describe, expect, it } from 'vitest';
import { taskCompletion } from './task-completion';

describe('task completion', () => {
  it.each([
    [0, 20, 0, 'red'], [2, 25, 8, 'red'], [49, 100, 49, 'red'],
    [50, 100, 50, 'yellow'], [99, 100, 99, 'yellow'], [20, 20, 100, 'green'],
    [0, 0, 0, 'red'], [1, 3, 33, 'red'], [2, 3, 67, 'yellow'],
  ] as const)('calculates %i / %i as %i%% in %s', (completed, total, percent, tone) => {
    expect(taskCompletion(completed, total)).toMatchObject({ completed, total, percent, tone });
  });
  it('does not claim full completion due to rounding', () => {
    expect(taskCompletion(199, 200)).toMatchObject({ percent: 99, ratio: 99.5, tone: 'yellow' });
  });
  it.each([
    [-1, 20, 0, 20], [30, 20, 20, 20], [2, -1, 0, 0],
    [NaN, 20, 0, 20], [Infinity, 20, 0, 20], [2, NaN, 0, 0],
    [2, Infinity, 0, 0], [2.9, 5.9, 2, 5],
  ])('clamps invalid or out-of-range counts %s / %s', (inputCompleted, inputTotal, completed, total) => {
    const progress = taskCompletion(inputCompleted, inputTotal);
    expect(progress).toMatchObject({ completed, total });
    expect(progress.ratio).toBeGreaterThanOrEqual(0);
    expect(progress.ratio).toBeLessThanOrEqual(100);
    expect(progress.percent).toBeGreaterThanOrEqual(0);
    expect(progress.percent).toBeLessThanOrEqual(100);
  });
});
