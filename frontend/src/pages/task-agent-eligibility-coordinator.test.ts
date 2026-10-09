import { expect, it } from 'vitest';
import { eligibilityPollDelay } from './task-agent-eligibility-coordinator';

it('backs off pending work and never polls a terminal verdict', () => {
  expect(eligibilityPollDelay('missing', 200_000)).toBe(10_000);
  expect(eligibilityPollDelay('queued', 29_999)).toBe(5_000);
  expect(eligibilityPollDelay('queued', 30_000)).toBe(10_000);
  expect(eligibilityPollDelay('running', 29_999)).toBe(2_000);
  expect(eligibilityPollDelay('running', 30_000)).toBe(5_000);
  expect(eligibilityPollDelay('running', 120_000)).toBe(10_000);
  for (const status of ['ready', 'failed', 'disabled']) expect(eligibilityPollDelay(status, 0)).toBe(Infinity);
});
