import { describe, expect, it, vi } from 'vitest';
import { mammothBlocks, parseWorkerDocument } from './document-parser.worker';
import type { DocumentWarning } from './document-parser-types';
import { getDocument } from 'pdfjs-dist';
import { readFileSync } from 'node:fs';
import type { DocumentBlock } from './document-parser-types';
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker-url' }));

const paragraph = (text: string, styleName?: string) => ({ type: 'paragraph', styleName, children: [{ type: 'run', children: [{ type: 'text', value: text }] }] });
describe('semantic DOCX extraction', () => {
  it('preserves heading paths, lists and table row/cell order without HTML', () => {
    const warnings: DocumentWarning[] = [];
    const blocks = [...mammothBlocks({ type: 'document', children: [
      paragraph('Chapter', 'Heading 1'), paragraph('Section', 'Heading 2'),
      { ...paragraph('item'), numbering: { level: 0, isOrdered: false } },
      { type: 'table', children: [
        { type: 'tableRow', children: [
          { type: 'tableCell', children: [paragraph('Name')] },
          { type: 'tableCell', children: [paragraph('<script>literal</script>')] },
        ] },
        { type: 'tableRow', children: [
          { type: 'tableCell', children: [paragraph('Alice')] },
          { type: 'tableCell', children: [paragraph('42')] },
        ] },
      ] }, paragraph('Next', 'Heading 1'),
    ] }, warnings)];
    expect(blocks[2]).toMatchObject({ pageNumber: null, seq: 2, text: '- item', headingPath: ['Chapter', 'Section'] });
    expect(blocks[3]?.text).toBe('Name\t<script>literal</script>\nAlice\t42');
    expect(blocks[4]?.headingPath).toEqual(['Next']);
    expect(warnings).toEqual([]);
  });
  it('reports skipped images and equations', () => {
    const warnings: DocumentWarning[] = [];
    Array.from(mammothBlocks({ type: 'document', children: [{ type: 'paragraph', children: [{ type: 'image' }, { type: 'math' }] }] }, warnings));
    expect(warnings.map(value => value.code)).toEqual(['images-not-read', 'math-not-read']);
  });
  it('segments long paragraphs without dropping text', () => {
    const original = '文'.repeat(40_000);
    const blocks = Array.from(mammothBlocks({ type: 'document', children: [paragraph(original)] }, []));
    expect(blocks.map(block => block.text).join('')).toBe(original);
    expect(blocks.map(block => block.seq)).toEqual([0, 1, 2]);
    expect(blocks.every(block => block.text.length <= 16_384)).toBe(true);
  });
  it('parses an actual DOCX ZIP using the browser distribution and surfaces equation omissions', async () => {
    const bytes = readFileSync('src/pages/__fixtures__/semantic.docx');
    const output: DocumentBlock[] = [];
    const data = new Uint8Array(bytes.length);
    data.set(bytes);
    const result = await parseWorkerDocument({ name: 'actual.docx', arrayBuffer: async () => data.buffer } as File, vi.fn(), async batch => { output.push(...batch); }, new AbortController().signal);
    expect(output.map(block => block.text)).toEqual(['Chapter', 'Name\tAlice', '<script>literal</script>']);
    expect(output[1]?.headingPath).toEqual(['Chapter']);
    expect(result.warnings.some(warning => warning.code === 'math-not-read')).toBe(true);
    expect(result.status).toBe('partial');
  });
});
describe('PDF extraction', () => {
  it('reads beyond 30 pages and waits for each consumer before loading the next page', async () => {
    const getPage = vi.fn(async () => ({ getTextContent: async () => ({ items: [{ str: 'page text', hasEOL: true }] }), cleanup: vi.fn() }));
    const destroy = vi.fn(async () => {});
    vi.mocked(getDocument).mockReturnValue({ promise: Promise.resolve({ numPages: 31, getPage }), destroy } as unknown as ReturnType<typeof getDocument>);
    const file = { name: 'test.pdf', arrayBuffer: async () => new ArrayBuffer(4) } as File;
    let delivered = 0;
    const result = await parseWorkerDocument(file, vi.fn(), async batch => {
      expect(getPage).toHaveBeenCalledTimes(delivered + 1);
      expect(batch[0]?.pageNumber).toBe(delivered + 1);
      delivered++;
    }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'complete', pages: 31, blocks: 31 });
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('reports partial output if a later page fails', async () => {
    const getPage = vi.fn().mockResolvedValueOnce({ getTextContent: async () => ({ items: [{ str: 'ok' }] }), cleanup: vi.fn() }).mockRejectedValueOnce(new Error('broken page'));
    vi.mocked(getDocument).mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy: vi.fn(async () => {}) } as unknown as ReturnType<typeof getDocument>);
    const result = await parseWorkerDocument({ name: 'test.pdf', arrayBuffer: async () => new ArrayBuffer(4) } as File, vi.fn(), async () => {}, new AbortController().signal);
    expect(result).toMatchObject({ status: 'partial', blocks: 1, warnings: [{ code: 'parse-failed', message: 'broken page' }] });
  });
});
