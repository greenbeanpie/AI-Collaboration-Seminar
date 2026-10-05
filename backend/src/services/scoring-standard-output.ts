import { z } from 'zod';
import { invalidState } from '../core/errors';
import type { ProjectReference } from './project-evidence';

const dimension = z.object({ key: z.string().regex(/^[a-zA-Z0-9_]+$/).max(40), label: z.string().trim().min(1).max(60), weight: z.number().min(0).max(1000), citations: z.array(z.object({ referenceId: z.string().min(1), quote: z.string().trim().min(1).max(800) }).strict()).max(10) }).strict();
export const scoringStandardOutputSchema = z.object({ methodSource: z.enum(['documented', 'proposed']), dimensions: z.array(dimension).min(1).max(10) }).strict().superRefine((output, ctx) => {
  if (new Set(output.dimensions.map(row => row.key)).size !== output.dimensions.length) ctx.addIssue({ code: 'custom', message: '评分维度标识不能重复' });
  const total = output.dimensions.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0 || (output.methodSource === 'proposed' && Math.abs(total - 100) > .001)) ctx.addIssue({ code: 'custom', message: '建议评分权重总和必须为100，已有评分方法须有有效分值' });
  if (output.dimensions.some(row => output.methodSource === 'proposed' ? row.citations.length > 0 : row.citations.length === 0)) ctx.addIssue({ code: 'custom', message: '已有评分方法必须引用评分原文；无已有评分方法时不能引用其他资料' });
  if (output.dimensions.some(row => (output.methodSource === 'proposed' ? /不得|请|必须|需要|注意|建议|待确认|待核验|截止|报名|参赛资格|团队人数|资料限制|任务状态|对应评分|criterion_/ : /对应评分|criterion_|资料限制|待确认/).test(row.label))) ctx.addIssue({ code: 'custom', message: '评分维度不能包含提示性要求或内部标识' });
});
const normalized = (value: string) => value.replace(/\s+/g, '').normalize('NFKC');
export function scoringDraft(output: z.infer<typeof scoringStandardOutputSchema>, references: ProjectReference[]) {
  const cleanReferences: ProjectReference[] = [];
  const total = output.dimensions.reduce((sum, row) => sum + row.weight, 0);
  const weights = output.dimensions.map((row, index) => ({ key: row.key, label: row.label, weight: index === output.dimensions.length - 1 ? 100 - output.dimensions.slice(0, index).reduce((sum, previous) => sum + previous.weight / total * 100, 0) : row.weight / total * 100 }));
  const requirements = output.dimensions.map(row => {
    const citations = row.citations.map(citation => {
      const ref = references.find(ref => ref.id === citation.referenceId);
      if (!ref || ref.resourceType !== 'source' || !ref.versionId || !ref.fragmentId || !ref.quote || !ref.quote.includes(citation.quote)) throw invalidState('评分引用必须来自实际读取的固定来源原文，不能引用总结或任务记录');
      const quote = normalized(citation.quote);
      if (!quote.includes(normalized(row.label)) || !new RegExp(`${String(row.weight).replace('.', '\\.')}[\\s]*(?:%|％|分|点|points)`, 'i').test(quote)) throw invalidState('引用必须包含该评分维度及其原始权重或分值，不能引用评分方法以外的原文');
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = citation.quote.match(new RegExp(String.raw`${escape(row.label)}[^0-9；;。\n]{0,80}${escape(String(row.weight))}\s*(?:%|％|分|点|points)`, 'i'));
      const scoringPassage = match?.[0];
      if (!scoringPassage) throw invalidState('评分引用须逐字包含评分维度与该项分值，不可拼接其他原文');
      if (citation.quote.slice(0, match!.index).trim() || citation.quote.slice(match!.index! + scoringPassage.length).replace(/[\s)）\]】。；;，,.:：]/g, '')) throw invalidState('评分引用只能包含该评分项与分值，不能附带其他资料原文');
      cleanReferences.push({ ...ref, quote: scoringPassage });
      return { sourceVersionId: ref.versionId, fragmentId: ref.fragmentId, pageNumber: ref.pageNumber ?? null, quote: scoringPassage };
    });
    return { title: row.label, detail: '', category: 'scoring' as const, dimensionKey: row.key, dueDate: null, duePrecision: 'unknown' as const, citations };
  });
  return { draft: { title: '项目评分标准', requirements, weights, notes: '' }, references: cleanReferences };
}
