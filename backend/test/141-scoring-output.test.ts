import { expect, it } from 'vitest';
import { scoringStandardOutputSchema, scoringDraft } from '../src/services/scoring-standard-output';
import type { ProjectReference } from '../src/services/project-evidence';
const proposed = { methodSource: 'proposed', dimensions: [{ key: 'quality', label: '成果质量', weight: 100, citations: [] }] };
it('rejects non-scoring fields at the AI output boundary, including old requirement and notes payloads', () => {
  expect(scoringStandardOutputSchema.safeParse(proposed).success).toBe(true);
  for (const extra of [{ notes: '待核验资料' }, { requirements: [{ category: 'deadline', detail: '报名截止' }] }]) expect(scoringStandardOutputSchema.safeParse({ ...proposed, ...extra }).success).toBe(false);
  expect(scoringStandardOutputSchema.safeParse({ ...proposed, dimensions: [{ ...proposed.dimensions[0], detail: '不得编造样本' }] }).success).toBe(false);
  expect(scoringStandardOutputSchema.safeParse({ ...proposed, dimensions: [{ ...proposed.dimensions[0], citations: [{ referenceId: 'ordinary', quote: '报名截止' }] }] }).success).toBe(false);
  const result = scoringDraft(scoringStandardOutputSchema.parse(proposed), []);
  expect(result.draft.requirements).toEqual([{ title: '成果质量', detail: '', category: 'scoring', dimensionKey: 'quality', dueDate: null, duePrecision: 'unknown', citations: [] }]);
  expect(result.draft.notes).toBe('');
});
it('preserves scoring-only source passages as real dimension citations and rejects unrelated originals', () => {
  const refs: ProjectReference[] = [{ id: 'r', resourceType: 'source', resourceId: 's', versionId: 'v', fragmentId: 'f', revision: 1, pageNumber: 2, quote: '作者简介。成果质量占 100 分。联系人说明。', usage: 'decision' }];
  const output = scoringStandardOutputSchema.parse({ methodSource: 'documented', dimensions: [{ key: 'quality', label: '成果质量', weight: 100, citations: [{ referenceId: 'r', quote: refs[0]!.quote }] }] });
  expect(() => scoringDraft(output, refs)).toThrow('其他资料原文');
  output.dimensions[0]!.citations[0]!.quote = '成果质量占 100 分';
  const result = scoringDraft(output, refs);
  expect(result.draft.requirements[0]!.citations).toEqual([{ sourceVersionId: 'v', fragmentId: 'f', pageNumber: 2, quote: '成果质量占 100 分' }]);
  expect(JSON.stringify(result)).not.toMatch(/作者简介|联系人/);
  expect(() => scoringDraft(output, [])).toThrow('实际读取');
  expect(() => scoringDraft({ ...output, dimensions: [{ ...output.dimensions[0]!, label: '未知维度' }] }, refs)).toThrow('该评分维度');
});
