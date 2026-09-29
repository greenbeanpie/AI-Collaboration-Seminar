import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { makePdf } from './helpers/make-pdf';

/**
 * unpdf CPU spike（backend_plan.md 12.1）：
 * 免费版 Workers 每次请求约 10ms CPU。本用例在本地 workerd 中测量
 * 提取 1/5/30 页 PDF 文本层的墙钟耗时（含 PDF 解析），为 M3 的
 * 「分页分步提取 vs 前端提取文本层 vs Workers Paid」决策提供数据。
 * 注意：本地 workerd 无法直接复现线上 CPU 计量，部署到免费计划后需复测。
 */
describe('unpdf 文本层提取 spike', () => {
  it.each([1, 5, 30])('提取 %i 页 PDF 并记录耗时', async (pages) => {
    const bytes = makePdf(pages);
    const started = performance.now();
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    const elapsed = performance.now() - started;

    expect(result.totalPages).toBe(pages);
    const texts = Array.isArray(result.text) ? result.text : [result.text];
    expect(texts).toHaveLength(pages);
    expect(texts[0]).toContain('Page 1:');
    console.info(`[spike-unpdf] pages=${pages} wallMs=${elapsed.toFixed(1)} chars=${texts.join('').length}`);
  });
});
