import { expect, it } from 'vitest';
import { projectReturnPath } from './project-return-path';
it('returns only routes inside the current project', () => {
  expect(projectReturnPath('/app/projects/p/assessment?section=reviews', 'p')).toBe('/app/projects/p/assessment?section=reviews');
  for (const value of ['https://evil.test/app/projects/p/data', '//evil.test/app/projects/p/data', '/app/projects/other/data', '/app/projects/p/../other/data', '/app/projects/p/data\\evil']) expect(projectReturnPath(value, 'p')).toBeNull();
});
