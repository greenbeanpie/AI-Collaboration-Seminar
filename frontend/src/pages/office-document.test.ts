import { describe, expect, it, vi } from 'vitest';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import * as XLSX from 'xlsx';
import { parseOfficeDocument } from './office-document';
import type { DocumentBlock } from './document-parser-types';

async function zip(parts: Record<string, string>): Promise<ArrayBuffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [path, value] of Object.entries(parts)) await writer.add(path, new Uint8ArrayReader(new TextEncoder().encode(value)), { level: 0 });
  return (await writer.close()).buffer as ArrayBuffer;
}
const paragraph = (value: string) => `<a:p><a:r><a:t>${value}</a:t></a:r></a:p>`;
const parts = {
  '[Content_Types].xml': '<Types/>',
  'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId r:id="later"/><p:sldId r:id="earlier"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="earlier" Type="namespace/slide" Target="slides/slide1.xml"/><Relationship Id="later" Type="namespace/slide" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': `<p:sld show="0"><p:cSld>${paragraph('中文第二页')}</p:cSld></p:sld>`,
  'ppt/slides/slide2.xml': `<p:sld><p:cSld>${paragraph('first &amp; value')}<a:tbl><a:tr><a:tc>${paragraph('姓名')}</a:tc><a:tc>${paragraph('数值')}</a:tc></a:tr><a:tr><a:tc>${paragraph('中文')}</a:tc><a:tc>${paragraph('42')}</a:tc></a:tr></a:tbl></p:cSld></p:sld>`,
  'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Type="namespace/notesSlide" Target="../notesSlides/notes2.xml"/></Relationships>',
  'ppt/notesSlides/notes2.xml': `<p:notes><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>${paragraph('讲稿内容')}</p:sp><p:sp><p:ph type="sldNum"/>${paragraph('999')}</p:sp></p:notes>`,
  'ppt/media/image.png': 'fake image content',
};
async function parse(buffer: ArrayBuffer, format: 'xlsx' | 'pptx') {
  const output: DocumentBlock[] = [];
  const result = await parseOfficeDocument(buffer, format, async batch => { output.push(...batch); }, new AbortController().signal, vi.fn());
  return { result, output };
}
describe('Office browser extraction', () => {
  it('reads sparse XLSX cells, Chinese, formatted dates, cached and missing formulas and hidden sheets', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['标题', 42], ['缓存', 84]]);
    sheet.B2.f = 'B1*2';
    sheet.C3 = { t: 'n', f: 'B1+1' };
    sheet.D4 = { t: 'n', v: 45292, z: 'yyyy-mm-dd' };
    sheet.Z999 = { t: 's', v: '<script>literal</script>' };
    sheet['!ref'] = 'A1:Z999';
    XLSX.utils.book_append_sheet(workbook, sheet, '预算');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['secret']]), '内部');
    workbook.Workbook = { Sheets: [{ name: '预算', Hidden: 0 }, { name: '内部', Hidden: 1 }] };
    const { result, output } = await parse(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }), 'xlsx');
    expect(output.map(block => block.text)).toEqual(['标题', '42', '缓存', '84', '[公式 B1+1：无已保存结果]', '2024-01-01', '<script>literal</script>', 'secret']);
    expect(output[6].headingPath).toEqual(['预算', 'Z999']);
    expect(output[7].headingPath).toEqual(['内部（隐藏工作表）', 'A1']);
    expect(output.every(block => block.pageNumber === null)).toBe(true);
    expect(result).toMatchObject({ status: 'partial', format: 'xlsx', pages: null, blocks: 8 });
    expect(result.warnings.map(warning => warning.code)).toContain('formula-cache');
  });
  it('reads PPTX actual slide relationship order, tables and notes with accurate locations', async () => {
    const { result, output } = await parse(await zip(parts), 'pptx');
    expect(output.map(block => block.text)).toEqual(['first & value', '姓名\t数值\n中文\t42', '讲稿内容', '中文第二页']);
    expect(output[0].headingPath).toEqual(['幻灯片 1', '正文']);
    expect(output[1].headingPath).toEqual(['幻灯片 1', '正文', '表格']);
    expect(output[2].headingPath).toEqual(['幻灯片 1', '演讲备注']);
    expect(output[3].headingPath).toEqual(['幻灯片 2（隐藏）', '正文']);
    expect(result.warnings.map(warning => warning.code)).toEqual(['objects-not-read', 'layout-not-read', 'hidden-content']);
  });
  it('retains acknowledged first slide when later slide XML is damaged', async () => {
    const { result, output } = await parse(await zip({ ...parts, 'ppt/slides/slide1.xml': '<broken>' }), 'pptx');
    expect(result).toMatchObject({ status: 'partial', blocks: 3 });
    expect(output).toHaveLength(3);
    expect(result.warnings.some(warning => warning.code === 'parse-failed')).toBe(true);
  });
  it('rejects arbitrary ZIPs and entity declarations', async () => {
    await expect(parse(await zip({ 'text.txt': 'hello' }), 'xlsx')).rejects.toThrow('必要内容');
    await expect(parse(await zip({ ...parts, 'ppt/presentation.xml': '<!DOCTYPE evil [<!ENTITY x "evil">]><p:presentation/>' }), 'pptx')).rejects.toThrow('XML');
  });
  it('propagates batch delivery failures instead of claiming a partial successful parse', async () => {
    await expect(parseOfficeDocument(await zip(parts), 'pptx', async () => { throw new Error('upload unavailable'); }, new AbortController().signal, vi.fn())).rejects.toThrow('upload unavailable');
  });
  it('segments long text into acknowledged batches without dropping characters', async () => {
    const large = '文'.repeat(16_384 * 25 + 12);
    const { output } = await parse(await zip({ ...parts, 'ppt/slides/slide2.xml': `<p:sld>${paragraph(large)}</p:sld>` }), 'pptx');
    expect(output.filter(block => block.headingPath?.[1] === '正文' && block.headingPath?.[0] === '幻灯片 1').map(block => block.text).join('')).toBe(large);
    expect(output.every(block => block.text.length <= 16_384)).toBe(true);
  });
  it('honors cancellation after one acknowledged batch', async () => {
    const controller = new AbortController();
    const large = '文'.repeat(16_384 * 25);
    const batches: DocumentBlock[][] = [];
    await expect(parseOfficeDocument(await zip({ ...parts, 'ppt/slides/slide2.xml': `<p:sld>${paragraph(large)}</p:sld>` }), 'pptx', async batch => {
      batches.push(batch); controller.abort();
    }, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(24);
    expect(batches[0].every(block => block.text.length <= 16_384)).toBe(true);
  });
  it('rejects external or escaping slide associations without network access', async () => {
    await expect(parse(await zip({ ...parts, 'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="later" Type="namespace/slide" TargetMode="External" Target="https://example.com/a.xml"/></Relationships>' }), 'pptx')).rejects.toThrow('关联无效');
    await expect(parse(await zip({ ...parts, 'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="later" Type="namespace/slide" Target="../../outside.xml"/></Relationships>' }), 'pptx')).rejects.toThrow('越界');
  });
});

