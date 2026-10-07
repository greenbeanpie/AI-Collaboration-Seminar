import { afterEach, describe, expect, it, vi } from 'vitest';
import { blocksToMarkdown, extractTaskFileText } from './task-file-text';
import { parseBrowserDocument } from './browser-document';
import { MAX_TASK_FILE_TEXT_CHARS, TASK_FILE_TEXT_TRUNCATION_NOTE } from '../../../shared/task-file-text';
import type { DocumentBatch, DocumentBlock } from './document-parser-types';

vi.mock('./browser-document', () => ({ parseBrowserDocument: vi.fn() }));
const parse = vi.mocked(parseBrowserDocument);
afterEach(() => { vi.resetAllMocks(); });

function parseResolves(blocks: DocumentBlock['text'][], status: 'complete' | 'partial' = 'complete', warnings: { code: string; message: string }[] = []) {
  parse.mockImplementation(async (_file, options) => {
    let batchId = 0;
    for (const text of blocks) {
      const batch: DocumentBatch = { batchId: batchId++, blocks: [{ pageNumber: null, seq: blocks.indexOf(text), text }] };
      await options.onBatch(batch);
    }
    return { status, format: 'docx', pages: null, blocks: blocks.length, warnings };
  });
}

describe('task file text extraction', () => {
  it('joins parsed blocks in sequence order with headings and blank lines', () => {
    const markdown = blocksToMarkdown([
      { pageNumber: null, seq: 2, text: '第二段。' },
      { pageNumber: null, seq: 0, text: '第一段。' },
      { pageNumber: null, seq: 1, text: '  ', headingPath: ['第一章', '第一节'] },
      { pageNumber: null, seq: 3, text: '第三段。', headingPath: ['第二章'] },
    ]);
    expect(markdown).toBe('第一段。\n\n第二段。\n\n## 第二章\n\n第三段。');
  });

  it('reads plain text and markdown files and normalizes line endings', async () => {
    const text = await extractTaskFileText(new File(['第一行。\r\n第二行。'], '成果.md'));
    expect(text).toEqual({ text: '第一行。\n第二行。' });
  });

  it('keeps the head of overly long text and appends the truncation note', async () => {
    const text = await extractTaskFileText(new File(['字'.repeat(MAX_TASK_FILE_TEXT_CHARS + 10)], '成果.txt'));
    expect(text?.text.startsWith('字'.repeat(100))).toBe(true);
    expect(text?.text.endsWith(`\n\n${TASK_FILE_TEXT_TRUNCATION_NOTE}`)).toBe(true);
    expect(text?.warning).toContain('截断');
  });

  it('returns null for types without a text pipeline', async () => {
    expect(await extractTaskFileText(new File(['bytes'], '照片.png'))).toBeNull();
    expect(await extractTaskFileText(new File(['bytes'], '录音.mp3'))).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it('collects parsed office blocks and flags partial parses', async () => {
    parseResolves(['案例有明确结果。']);
    expect(await extractTaskFileText(new File(['bytes'], '成果.docx'))).toEqual({ text: '案例有明确结果。' });
    parseResolves(['前半部分。'], 'partial', [{ code: 'page-failed', message: '第 3 页无法读取' }]);
    const partial = await extractTaskFileText(new File(['bytes'], '成果.pdf'));
    expect(partial?.text).toBe('前半部分。');
    expect(partial?.warning).toContain('第 3 页无法读取');
  });

  it('degrades to no text with a warning when a scanned document has no extractable body', async () => {
    parseResolves([]);
    expect(await extractTaskFileText(new File(['bytes'], '扫描件.pdf'))).toEqual({ text: '', warning: expect.stringContaining('未能从文件中提取到文字内容') });
  });

  it('returns null instead of failing registration when parsing throws', async () => {
    parse.mockRejectedValue(new Error('文件包含无效或不支持的 XML。'));
    expect(await extractTaskFileText(new File(['bytes'], '损坏.docx'))).toBeNull();
  });
});
