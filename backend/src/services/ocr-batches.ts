import { MULTIMODAL_LIMITS } from '../ai/multimodal-limits';
import { z } from 'zod';
import { AppError } from '../core/errors';
import type { DocumentFragment } from './document-chunks';

export const ocrPageSchema = z.object({
  pageNumber: z.number().int().positive(), text: z.string().max(20000).default(''),
  confidence: z.number().min(0).max(1).nullable().default(null),
  unrecognizedRegions: z.array(z.string().max(1000)).max(50).default([]),
});
export type OcrPageOutput = z.infer<typeof ocrPageSchema>;
/** Preserve individually valid pages even if a neighbour was omitted or malformed. */
export function parseOcrBatch(raw: unknown, expected: number[]): OcrPageOutput[] {
  const value = raw as { pages?: unknown[]; text?: unknown; confidence?: unknown } | null;
  const rows = Array.isArray(value?.pages) ? value.pages : expected.length === 1 && value && 'text' in value
    ? [{ ...value, pageNumber: expected[0] }] : [];
  const counts = new Map<number, number>();
  for (const row of rows) { const n = (row as { pageNumber?: number } | null)?.pageNumber; if (n !== undefined) counts.set(n, (counts.get(n) ?? 0) + 1); }
  return rows.flatMap(row => { const parsed = ocrPageSchema.safeParse(row); return parsed.success && expected.includes(parsed.data.pageNumber) && counts.get(parsed.data.pageNumber) === 1 && parsed.data.text.trim() ? [parsed.data] : []; });
}
export function ocrContext(previous: string, maxInputChars: number): string {
  const limit = Math.min(1500, Math.floor(maxInputChars / 10));
  if (!limit) return '';
  let text = previous.slice(-limit); if (/^[\uDC00-\uDFFF]/u.test(text)) text = text.slice(1);
  return text;
}
/** Batch only consecutive pages. Bound serialized images and output budget. */
export function ocrBatchSize(pages: Array<{ page_number: number; size_bytes?: number | null }>, _maxInputChars: number, maxOutputTokens: number): number {
  const bodyBudget = MULTIMODAL_LIMITS.imagePayloadBytes;
  let bytes = 0; let count = 0;
  for (const page of pages.slice(0, Math.min(3, Math.max(1, Math.floor(maxOutputTokens / 2000))))) {
    if (count && page.page_number !== pages[count - 1]!.page_number + 1) break;
    const size = page.size_bytes ?? MULTIMODAL_LIMITS.imageBytes;
    if (size > MULTIMODAL_LIMITS.imageBytes) { if (!count) throw new AppError('QUOTA_EXCEEDED','单张页面图超过2 MiB处理边界，请降低图片大小',422,false); break; }
    const next = Math.ceil(size / 3) * 4 + 256;
    if (bytes + next > bodyBudget) break;
    bytes += next; count++;
  }
  if (!count) throw new AppError('QUOTA_EXCEEDED', '单张页面图超过当前模型请求预算，请降低图片大小或调整模型输入预算', 422, false);
  return count;
}
export function removeOcrDuplicates(text: string, existing: string[]): string {
  const normalize = (s: string) => s.replace(/\s+/gu, '').toLowerCase();
  const known = existing.map(normalize);
  return text.split(/\n+/u).filter(line => { const n = normalize(line); return n && !known.some(content => content.includes(n)); }).join('\n');
}
/** Context is read, citable original text; callers count coverage on core chunks only. */
export function summaryBoundaryContext<T extends DocumentFragment>(chunks: T[][], index: number, limit: number): T[] {
  if (!limit) return [];
  const previous = chunks[index - 1]?.at(-1); const next = chunks[index + 1]?.[0];
  const tail = previous?.content.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, '');
  const head = next?.content.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
  return [previous ? { ...previous, content: tail! } : null,
    next ? { ...next, content: head! } : null].filter((f): f is T => f !== null);
}
