import mammoth from 'mammoth/mammoth.browser';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseOfficeDocument } from './office-document';
import type { BrowserDocumentResult, DocumentBlock, DocumentWarning, ParserRequest, ParserResponse } from './document-parser-types';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
type Node = { type: string; children?: Node[]; value?: string; styleId?: string; styleName?: string; numbering?: { level: string | number; isOrdered: boolean } };
const abortError = () => new DOMException('文档读取已取消。', 'AbortError');
const warning = (code: string, message: string): DocumentWarning => ({ code, message });

/** Read Mammoth's semantic document tree; never insert or render its generated HTML. */
export function* mammothBlocks(root: Node, warnings: DocumentWarning[]): Generator<DocumentBlock> {
  const headings: string[] = [];
  const seen = new Set<string>();
  let seq = 0;
  const warn = (code: string, message: string) => {
    if (!seen.has(code)) { seen.add(code); warnings.push(warning(code, message)); }
  };
  const text = (node: Node): string => {
    if (node.type === 'text') return node.value || '';
    if (node.type === 'break') return '\n';
    if (node.type === 'tab') return '\t';
    if (node.type === 'image') { warn('images-not-read', '图片已跳过；图片内文字、图表需要单独识别。'); return ''; }
    if (node.type === 'noteReference' || node.type === 'commentReference') { warn('notes-not-read', '脚注、尾注或批注引用未读取全文，请核对原文。'); return ''; }
    if (/math/i.test(node.type)) { warn('math-not-read', '公式未可靠转换，请核对原文。'); return ''; }
    const supported = ['document', 'paragraph', 'run', 'table', 'tableRow', 'tableCell', 'hyperlink', 'bookmarkStart'];
    if (!supported.includes(node.type)) warn('unsupported-content', `部分文档结构未可靠转换（${node.type}）。`);
    return (node.children || []).map(text).join(node.type === 'tableRow' ? '\t' : node.type === 'table' || node.type === 'tableCell' ? '\n' : '');
  };
  function* visit(node: Node): Generator<DocumentBlock> {
    if (node.type === 'paragraph' || node.type === 'table') {
      let value = text(node).trim();
      if (!value) return;
      if (node.type === 'paragraph') {
        const match = /^(?:heading|标题)\s*([1-9])/i.exec(node.styleName || '') || /^Heading([1-9])/i.exec(node.styleId || '');
        if (match) {
          const level = Number(match[1]);
          headings.splice(level - 1);
          headings[level - 1] = value;
        }
        if (node.numbering) value = `${'  '.repeat(Math.min(Number(node.numbering.level) || 0, 9))}${node.numbering.isOrdered ? '1.' : '-'} ${value}`;
      }
      // Preserve all text while bounding messages even for a very large paragraph/table.
      for (let offset = 0; offset < value.length; offset += 16_384) {
        yield { pageNumber: null, seq: seq++, text: value.slice(offset, offset + 16_384), ...(headings.some(Boolean) ? { headingPath: headings.filter(Boolean) } : {}) };
      }
      return;
    }
    for (const child of node.children || []) yield* visit(child);
  }
  yield* visit(root);
}

export async function parseWorkerDocument(file: File, emit: (message: ParserResponse) => void, sendBatch: (blocks: DocumentBlock[]) => Promise<void>, signal: AbortSignal): Promise<BrowserDocumentResult> {
  const check = () => { if (signal.aborted) throw abortError(); };
  const format = /\.docx$/i.test(file.name) ? 'docx' : /\.pdf$/i.test(file.name) ? 'pdf' : /\.xlsx$/i.test(file.name) ? 'xlsx' : /\.pptx$/i.test(file.name) ? 'pptx' : null;
  if (!format) throw new Error('浏览器读取仅支持 PDF、DOCX、XLSX 和 PPTX。');
  const warnings: DocumentWarning[] = [];
  let blocks = 0;
  let pages: number | null = null;
  emit({ type: 'progress', progress: { phase: 'reading', completed: 0, total: null } });
  check();
  const buffer = await file.arrayBuffer();
  check();
  if (format === 'xlsx' || format === 'pptx') return parseOfficeDocument(buffer, format, sendBatch, signal, (completed, total) => emit({ type: 'progress', progress: { phase: 'parsing', completed, total } }));
  if (format === 'pdf') {
    const task = getDocument({ data: new Uint8Array(buffer) });
    const cancel = () => { void task.destroy(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const pdf = await task.promise;
      pages = pdf.numPages;
      for (let number = 1; number <= pdf.numPages; number++) {
        check();
        const page = await pdf.getPage(number);
        try {
          const content = await page.getTextContent();
          const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
          const pageWarnings: DocumentWarning[] = text ? [] : [{ code: 'empty-page', message: '本页没有可提取文字；扫描页或图片需单独识别。', pageNumber: number }];
          warnings.push(...pageWarnings);
          check();
          const chunks = Math.max(1, Math.ceil(text.length / 16_384));
          for (let start = 0; start < chunks; start += 24) {
            const batch: DocumentBlock[] = [];
            for (let chunk = start; chunk < Math.min(chunks, start + 24); chunk++) {
              batch.push({ pageNumber: number, seq: blocks++, text: text.slice(chunk * 16_384, (chunk + 1) * 16_384), ...(pageWarnings.length ? { warnings: pageWarnings } : {}) });
            }
            check();
            await sendBatch(batch);
          }
          emit({ type: 'progress', progress: { phase: 'parsing', completed: number, total: pdf.numPages } });
        } finally { page.cleanup(); }
      }
    } catch (error) {
      check();
      if (!blocks) throw error;
      warnings.push(warning('parse-failed', error instanceof Error ? error.message : 'PDF 后续页面读取失败。'));
      return { status: 'partial', format, pages, blocks, warnings };
    } finally { signal.removeEventListener('abort', cancel); await task.destroy(); }
  } else {
    // DOCX ZIP/XML parsing is inherently whole-buffer: allocation failures are surfaced, not truncated.
    let root: Node | undefined;
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      transformDocument: (document: Node) => { root = document; return document; },
    });
    check();
    for (const message of result.messages) warnings.push(warning(/math|oMath/i.test(message.message) ? 'math-not-read' : 'conversion-warning', message.message));
    if (!root) throw new Error('DOCX 未返回可读取的文档结构。');
    let batch: DocumentBlock[] = [];
    for (const block of mammothBlocks(root, warnings)) {
      check();
      batch.push(block);
      blocks++;
      if (batch.length === 24) {
        await sendBatch(batch);
        batch = [];
        emit({ type: 'progress', progress: { phase: 'parsing', completed: blocks, total: null } });
      }
    }
    if (batch.length) await sendBatch(batch);
    if (!blocks) warnings.push(warning('no-text', 'DOCX 中没有可读取正文，图片或嵌入对象需单独识别。'));
  }
  check();
  return { status: warnings.length ? 'partial' : 'complete', format, pages, blocks, warnings };
}

// One parse per dedicated worker, with at most one unacknowledged batch.
if (typeof globalThis.document === 'undefined') {
  const scope = globalThis as unknown as { postMessage: (message: ParserResponse) => void; onmessage: (event: MessageEvent<ParserRequest>) => void };
  const controller = new AbortController();
  let started = false;
  let batchId = 0;
  let pending: { id: number; resolve: () => void; reject: (error: unknown) => void } | null = null;
  const emit = (message: ParserResponse) => scope.postMessage(message);
  scope.onmessage = event => {
    const request = event.data;
    if (request.type === 'cancel') {
      controller.abort();
      pending?.reject(abortError());
      pending = null;
    } else if (request.type === 'ack') {
      if (pending?.id === request.batchId) { pending.resolve(); pending = null; }
      else { controller.abort(); pending?.reject(new Error('文档批次确认错误。')); }
    } else if (!started) {
      started = true;
      const sendBatch = (batch: DocumentBlock[]) => new Promise<void>((resolve, reject) => {
        if (controller.signal.aborted) { reject(abortError()); return; }
        const id = batchId++;
        pending = { id, resolve, reject };
        emit({ type: 'batch', batch: { batchId: id, blocks: batch } });
      });
      void parseWorkerDocument(request.file, emit, sendBatch, controller.signal)
        .then(result => emit({ type: 'done', result }))
        .catch(error => emit({ type: 'error', name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : '文档读取失败，可能是设备内存不足。' }));
    }
  };
}
