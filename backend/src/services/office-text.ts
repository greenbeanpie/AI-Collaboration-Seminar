import { inflateRawSync } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { isOfficeExtension, validateOfficePackage } from './docx-validation';

type Node = { [key: string]: Node[] | Record<string, string> | string };
const name = (node: Node) => Object.keys(node).find(key => key !== ':@') ?? '';
const children = (node: Node): Node[] => { const value = node[name(node)]; return Array.isArray(value) ? value : []; };
const attrs = (node: Node): Record<string, string> => node[':@'] as Record<string, string> ?? {};
function* find(nodes: Node[], tag: string): Generator<Node> { for (const node of nodes) { if (name(node) === tag) yield node; yield* find(children(node), tag); } }
const value = (nodes: Node[]): string => nodes.map(node => name(node) === '#text' ? String(node['#text']) : ['w:tab'].includes(name(node)) ? '\t' : ['w:br', 'a:br'].includes(name(node)) ? '\n' : value(children(node))).join('');
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, parseTagValue: false, processEntities: true });
const MAX_PART = 16 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
const fail = (message: string): never => { throw new Error(`Office 正文提取失败：${message}`); };
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded OOXML reader. Media is never inflated; macros and external links are never executed. */
function packageReader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset: number, size: number) => { if (offset < 0 || size < 0 || offset + size > bytes.length) fail('ZIP 偏移无效'); };
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === bytes.length) { end = pos; break; }
  }
  if (end < 0) fail('ZIP 目录缺失');
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count > 10000 || start + size !== end) fail('不支持分卷、ZIP64 或过大的 ZIP 目录');
  const files = new Map<string, { offset: number; compressed: number; expanded: number; method: number; crc: number }>();
  let pos = start, declared = 0;
  for (let i = 0; i < count; i++) {
    check(pos, 46);
    const flags = view.getUint16(pos + 8, true), method = view.getUint16(pos + 10, true), compressed = view.getUint32(pos + 20, true), expanded = view.getUint32(pos + 24, true);
    const length = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true);
    if (view.getUint32(pos, true) !== 0x02014b50 || flags & 0x41 || ![0, 8].includes(method) || !length || length > 4096) fail('包已加密或压缩格式无效');
    check(pos, 46 + length + extra + comment);
    const path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(pos + 46, pos + 46 + length));
    if (path.startsWith('/') || /[\\\x00:]/.test(path) || path.split('/').some(part => part === '..' || part === '.') || files.has(path)) fail('内部路径无效或重复');
    declared += expanded;
    if (expanded > MAX_PART || declared > MAX_TOTAL) fail('展开大小超过安全上限');
    files.set(path, { offset: view.getUint32(pos + 42, true), compressed, expanded, method, crc: view.getUint32(pos + 16, true) });
    pos += 46 + length + extra + comment;
  }
  if (pos !== end) fail('ZIP 目录长度不符');
  let inflated = 0;
  const cache = new Map<string, Node[]>();
  const read = (path: string): Node[] => {
    if (cache.has(path)) return cache.get(path)!;
    const entry = files.get(path); if (!entry) return fail(`缺少 ${path}`);
    check(entry.offset, 30);
    if (view.getUint32(entry.offset, true) !== 0x04034b50 || view.getUint16(entry.offset + 6, true) & 0x41 || view.getUint16(entry.offset + 8, true) !== entry.method) fail('ZIP 内容头无效');
    const length = view.getUint16(entry.offset + 26, true), extra = view.getUint16(entry.offset + 28, true);
    check(entry.offset + 30, length + extra);
    if (new TextDecoder().decode(bytes.subarray(entry.offset + 30, entry.offset + 30 + length)) !== path) fail('ZIP 内容路径不符');
    const offset = entry.offset + 30 + length + extra;
    check(offset, entry.compressed); if (offset + entry.compressed > start) fail('ZIP 内容越界');
    let data: Uint8Array;
    try { data = entry.method === 0 ? bytes.subarray(offset, offset + entry.compressed) : inflateRawSync(bytes.subarray(offset, offset + entry.compressed), { maxOutputLength: MAX_PART }); } catch { return fail('解压失败或展开大小超过安全上限'); }
    inflated += data.length;
    if (data.length !== entry.expanded || inflated > MAX_TOTAL) fail('展开长度不符或超过安全上限');
    if (crc32(data) !== entry.crc) fail('ZIP 内容校验失败');
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) fail('XML 无效或包含 DTD／实体声明');
    const nodes = parser.parse(xml) as Node[]; cache.set(path, nodes); return nodes;
  };
  return { files, read };
}

function resolve(source: string, target: string): string {
  if (/^[a-z]+:|\\|[?#\x00]/i.test(target)) return fail('内部关联路径无效');
  const result: string[] = [];
  for (const part of (target.startsWith('/') ? target.slice(1) : source.slice(0, source.lastIndexOf('/') + 1) + target).split('/')) {
    if (part === '..') { if (!result.length) fail('内部关联越界'); result.pop(); } else if (part && part !== '.') result.push(part);
  }
  return result.join('/');
}

export async function extractOfficeText(bytes: Uint8Array, ext: string): Promise<{ blocks: Array<{ text: string; headingPath?: string[] }>; warnings: string[] }> {
  ext = ext.toLowerCase(); if (!ext.startsWith('.')) ext = '.' + ext;
  if (!isOfficeExtension(ext)) return fail('不支持的 Office 格式');
  const { files, read } = packageReader(bytes);
  await validateOfficePackage(ext, bytes.length, async (offset, length) => bytes.slice(offset, offset + length));
  read('[Content_Types].xml');
  const blocks: Array<{ text: string; headingPath?: string[] }> = [], warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const add = (text: string, headingPath?: string[]) => { if (text.trim()) for (let pos = 0; pos < text.length; pos += 16384) blocks.push({ text: text.slice(pos, pos + 16384), headingPath }); };
  if ([...files.keys()].some(path => /\/(media|drawings|charts|embeddings)\//.test(path))) warn('图片、图表、绘图和嵌入对象未读取，请核对原文件。');
  const relation = (source: string, id: string, suffix: string) => {
    const slash = source.lastIndexOf('/'), relPath = source.slice(0, slash + 1) + '_rels/' + source.slice(slash + 1) + '.rels';
    const rel = [...find(read(relPath), 'Relationship')].find(node => attrs(node).Id === id);
    if (!rel || attrs(rel).TargetMode === 'External' || !attrs(rel).Type?.endsWith(suffix)) return fail('内容关联缺失或指向外部');
    return resolve(source, attrs(rel).Target ?? '');
  };
  if (ext === '.docx') {
    const document = read('word/document.xml');
    let heading: string[] = [];
    const visit = (nodes: Node[]) => { for (const node of nodes) {
      if (name(node) === 'w:tbl') {
        const rows = [...find(children(node), 'w:tr')].map(row => children(row).filter(cell => name(cell) === 'w:tc').map(cell => [...find(children(cell), 'w:p')].map(p => value(children(p))).join('\n')).join('\t'));
        add(rows.join('\n'), [...heading, '表格']);
      } else if (name(node) === 'w:p') {
        const style = [...find(children(node), 'w:pStyle')][0], text = value(children(node)), level = /^Heading([1-9])$/i.exec(style ? attrs(style)['w:val'] ?? '' : '');
        if (level) heading = [...heading.slice(0, Number(level[1]) - 1), text];
        add(text, heading);
      } else visit(children(node));
    } };
    visit([...find(document, 'w:body')].flatMap(children));
    if ([...find(document, 'm:oMath')].length) warn('数学公式仅保留可读取文字，公式版式未复原。');
    warn('页码、版式、页眉页脚、批注及修订显示状态未复原，请核对原文件。');
  } else if (ext === '.xlsx') {
    const shared = files.has('xl/sharedStrings.xml') ? [...find(read('xl/sharedStrings.xml'), 'si')].map(node => value(children(node))) : [];
    for (const sheet of find(read('xl/workbook.xml'), 'sheet')) {
      const sheetName = attrs(sheet).name ?? '工作表', hidden = attrs(sheet).state && attrs(sheet).state !== 'visible';
      if (hidden) warn('隐藏工作表／行／列已读取，请核对原文件。');
      const nodes = read(relation('xl/workbook.xml', attrs(sheet)['r:id'] ?? '', '/worksheet'));
      if ([...find(nodes, 'mergeCell')].length) warn('合并单元格仅保留文件存储的值，版式未复原。');
      for (const cell of find(nodes, 'c')) {
        const formula = [...find(children(cell), 'f')][0], raw = value([...find(children(cell), 'v')]);
        if (formula) warn('公式只读取文件保存的结果，不重新计算；缓存值可能过期。');
        let text = attrs(cell).t === 's' ? shared[Number(raw)] : attrs(cell).t === 'inlineStr' ? value([...find(children(cell), 'is')]) : raw;
        if (attrs(cell).t === 's' && (raw.trim() === '' || !/^\d+$/.test(raw) || text === undefined)) fail('共享字符串索引无效');
        if (formula && !text) text = `[公式 ${value(children(formula))}：无已保存结果]`;
        add(text ?? '', [sheetName + (hidden ? '（隐藏工作表）' : ''), attrs(cell).r ?? '单元格']);
      }
    }
    warn('单元格格式、日期显示样式及批注未复原，请核对原文件。');
  } else {
    let index = 0;
    for (const slide of find(read('ppt/presentation.xml'), 'p:sldId')) {
      const nodes = read(relation('ppt/presentation.xml', attrs(slide)['r:id'] ?? '', '/slide')), label = `幻灯片 ${++index}`;
      const visit = (items: Node[]) => { for (const node of items) {
        if (name(node) === 'a:tbl') add([...find(children(node), 'a:tr')].map(row => children(row).filter(cell => name(cell) === 'a:tc').map(cell => [...find(children(cell), 'a:p')].map(p => value(children(p))).join('\n')).join('\t')).join('\n'), [label, '表格']);
        else if (name(node) === 'a:p') add(value(children(node)), [label]); else visit(children(node));
      } }; visit(nodes);
    }
    warn('仅提取幻灯片正文及表格；备注、母版、视觉版式和动画未读取。');
  }
  if (!blocks.length) warn('文件中没有可读取正文，图片或嵌入对象需单独识别。');
  return { blocks, warnings };
}
