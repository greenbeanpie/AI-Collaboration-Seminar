import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import type { BrowserDocumentResult, DocumentBlock, DocumentWarning } from './document-parser-types';

type XmlNode = { [key: string]: XmlNode[] | Record<string, string> | string };
const children = (node: XmlNode): XmlNode[] => Object.entries(node).find(([key]) => key !== ':@')?.[1] as XmlNode[] || [];
const name = (node: XmlNode): string => Object.keys(node).find(key => key !== ':@') || '';
const attrs = (node: XmlNode): Record<string, string> => node[':@'] as Record<string, string> || {};
function* find(nodes: XmlNode[], tag: string): Generator<XmlNode> {
  for (const node of nodes) {
    if (name(node) === tag) yield node;
    const nested = children(node);
    if (Array.isArray(nested)) yield* find(nested, tag);
  }
}
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, parseTagValue: false, processEntities: true });
function xml(value: string): XmlNode[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true) throw new Error('文件包含无效或不支持的 XML。');
  return parser.parse(value) as XmlNode[];
}
function resolvePart(source: string, target: string): string {
  if (/^[a-z]+:|\\|[?#]/i.test(target)) throw new Error('文件内部关联路径无效。');
  const parts = (target.startsWith('/') ? target.slice(1) : `${source.slice(0, source.lastIndexOf('/') + 1)}${target}`).split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (part === '..') { if (!result.length) throw new Error('文件内部关联越界。'); result.pop(); }
    else if (part && part !== '.') result.push(part);
  }
  return result.join('/');
}
function relationshipPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
function text(nodes: XmlNode[]): string {
  return nodes.map(node => name(node) === '#text' ? String(node['#text']) : name(node) === 'a:br' ? '\n' : text(Array.isArray(children(node)) ? children(node) : [])).join('');
}

/** OOXML extraction runs entirely inside the existing dedicated document worker. */
export async function parseOfficeDocument(
  buffer: ArrayBuffer, format: 'xlsx' | 'pptx', sendBatch: (blocks: DocumentBlock[]) => Promise<void>,
  signal: AbortSignal, progress: (completed: number, total: number | null) => void,
): Promise<BrowserDocumentResult> {
  const check = () => { if (signal.aborted) throw new DOMException('文档读取已取消。', 'AbortError'); };
  const warnings: DocumentWarning[] = [];
  const warn = (code: string, message: string) => { if (!warnings.some(warning => warning.code === code)) warnings.push({ code, message }); };
  let blocks = 0;
  let acknowledged = 0;
  let deliveryFailed = false;
  let batch: DocumentBlock[] = [];
  const flush = async () => {
    if (batch.length) {
      check();
      try { await sendBatch(batch); } catch (error) { deliveryFailed = true; throw error; }
      acknowledged += batch.length; batch = [];
    }
  };
  const add = async (value: string, headingPath: string[]) => {
    if (!value.trim()) return;
    for (let offset = 0; offset < value.length; offset += 16_384) {
      check(); batch.push({ pageNumber: null, seq: blocks++, text: value.slice(offset, offset + 16_384), headingPath });
      if (batch.length === 24) await flush();
    }
  };
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)), { useWebWorkers: false, signal, checkSignature: true });
  try {
    check();
    const entries = await reader.getEntries();
    if (entries.some(entry => entry.encrypted)) throw new Error('请先在 Office 中解除文件加密后重新上传。');
    if (new Set(entries.map(entry => entry.filename)).size !== entries.length) throw new Error('文件包含重复的内部路径。');
    const files = new Map(entries.filter(entry => !entry.directory).map(entry => [entry.filename, entry]));
    const read = async (path: string): Promise<XmlNode[]> => {
      check(); const entry = files.get(path);
      if (!entry || !('getData' in entry)) throw new Error(`文件缺少必要内容：${path}`);
      return xml(new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter(), { signal, useWebWorkers: false })));
    };
    await read('[Content_Types].xml');
    if (Array.from(files.keys()).some(path => /\/(media|drawings|charts|embeddings)\//.test(path))) warn('objects-not-read', '图片、图表、绘图或嵌入对象未读取；请核对原文件。');
    if (format === 'xlsx') {
      await read('xl/workbook.xml');
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, cellFormula: true, cellText: true, cellStyles: true });
      check();
      for (const [index, sheetName] of workbook.SheetNames.entries()) {
        const sheet = workbook.Sheets[sheetName];
        const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden;
        if (hidden) warn('hidden-content', '包含隐藏工作表／行／列，已读取并标记，请核对原文件。');
        if (sheet['!rows']?.some(row => row?.hidden) || sheet['!cols']?.some(column => column?.hidden)) warn('hidden-content', '包含隐藏工作表／行／列，已读取并标记，请核对原文件。');
        if (sheet['!merges']?.length) warn('merged-cells', '合并单元格仅保留左上角值，版式未复原。');
        const addresses = Object.keys(sheet).filter(address => /^[A-Z]+[1-9][0-9]*$/.test(address)).sort((a, b) => {
          const aa = XLSX.utils.decode_cell(a), bb = XLSX.utils.decode_cell(b); return aa.r - bb.r || aa.c - bb.c;
        });
        for (const address of addresses) {
          const cell = sheet[address] as XLSX.CellObject;
          if (cell.c?.length) warn('comments-not-read', '单元格批注未读取。');
          if (cell.f) warn('formula-cache', '公式只读取文件中保存的结果，不重新计算；缓存值可能过期，缺失时已标记。');
          const value = cell.v == null ? cell.f ? `[公式 ${cell.f}：无已保存结果]` : '' : cell.w ?? XLSX.utils.format_cell(cell);
          const position = XLSX.utils.decode_cell(address);
          const label = sheet['!rows']?.[position.r]?.hidden || sheet['!cols']?.[position.c]?.hidden ? `${address}（隐藏行／列）` : address;
          await add(value, [hidden ? `${sheetName}（隐藏工作表）` : sheetName, label]);
        }
        await flush(); progress(index + 1, workbook.SheetNames.length);
      }
    } else {
      const presentation = await read('ppt/presentation.xml');
      const relationships = Array.from(find(await read('ppt/_rels/presentation.xml.rels'), 'Relationship'));
      const slides = Array.from(find(presentation, 'p:sldId'));
      warn('layout-not-read', '只读取幻灯片文字、表格及演讲备注；视觉版式、动画和母版内容未复原。');
      for (const [index, slide] of slides.entries()) {
        check();
        const rel = relationships.find(node => attrs(node).Id === attrs(slide)['r:id']);
        if (!rel || attrs(rel).TargetMode === 'External' || !attrs(rel).Type?.endsWith('/slide')) throw new Error('幻灯片关联无效。');
        const path = resolvePart('ppt/presentation.xml', attrs(rel).Target);
        const nodes = await read(path);
        const hidden = ['0', 'false'].includes(attrs(Array.from(find(nodes, 'p:sld'))[0] || {}).show);
        if (hidden) warn('hidden-content', '隐藏幻灯片已读取并标记，请核对原文件。');
        const label = `幻灯片 ${index + 1}${hidden ? '（隐藏）' : ''}`;
        const emitContent = async (content: XmlNode[], role: string) => {
          async function visit(items: XmlNode[]): Promise<void> {
            for (const node of items) {
              if (name(node) === 'a:tbl') {
                const rows = Array.from(find(children(node), 'a:tr')).map(row => children(row).filter(cell => name(cell) === 'a:tc').map(cell => Array.from(find(children(cell), 'a:p')).map(paragraph => text(children(paragraph))).join('\n')).join('\t'));
                await add(rows.join('\n'), [label, role, '表格']);
              } else if (name(node) === 'a:p') await add(text(children(node)), [label, role]);
              else if (Array.isArray(children(node))) await visit(children(node));
            }
          }
          await visit(content);
        };
        await emitContent(nodes, '正文');
        const relPath = relationshipPath(path);
        if (files.has(relPath)) {
          const notesRel = Array.from(find(await read(relPath), 'Relationship')).find(node => attrs(node).Type?.endsWith('/notesSlide'));
          if (notesRel) {
            if (attrs(notesRel).TargetMode === 'External') warn('notes-not-read', '外部演讲备注未读取。');
            else {
              const notes = await read(resolvePart(path, attrs(notesRel).Target));
              // Skip slide-number/date/footer placeholders, which are not speaker notes.
              for (const shape of find(notes, 'p:sp')) {
                const placeholders = Array.from(find(children(shape), 'p:ph'));
                if (placeholders.some(node => ['sldNum', 'dt', 'ftr', 'hdr', 'sldImg'].includes(attrs(node).type))) continue;
                await emitContent(children(shape), '演讲备注');
              }
            }
          }
        }
        await flush(); progress(index + 1, slides.length);
      }
    }
    if (!blocks) warn('no-text', '文件中没有可读取正文，图片或嵌入对象需单独识别。');
    await flush(); check();
    return { status: warnings.length ? 'partial' : 'complete', format, pages: null, blocks, warnings };
  } catch (error) {
    check();
    // Consumer upload failures must propagate; only already acknowledged batches can be retained.
    if (!blocks || deliveryFailed) throw error;
    await flush();
    warn('parse-failed', error instanceof Error ? error.message : '文件后续内容读取失败。');
    return { status: 'partial', format, pages: null, blocks: acknowledged, warnings };
  } finally { await reader.close(); }
}
