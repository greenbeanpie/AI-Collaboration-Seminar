import { parseBrowserDocument } from './browser-document';
import type { DocumentBlock } from './document-parser-types';
import { MAX_TASK_FILE_TEXT_CHARS, TASK_FILE_TEXT_TRUNCATION_NOTE } from '../../../shared/task-file-text';

/** 现有浏览器解析管线支持的格式；图片、音视频等其余类型不提取，保持仅附件。 */
const PARSEABLE_EXTENSIONS = ['.docx', '.pdf', '.xlsx', '.pptx'];
const TEXT_EXTENSIONS = ['.txt', '.md'];

/** 该文件名是否属于「本应提取正文」的类型；用于解析失败时提示用户，而不是当作无关类型静默跳过。 */
export function isTextExtractable(fileName: string): boolean {
  const extension = extensionOf(fileName);
  return PARSEABLE_EXTENSIONS.includes(extension) || TEXT_EXTENSIONS.includes(extension);
}

export type ExtractedTaskFileText = {
  text: string;
  /** 非空表示正文经过了截断或来源不完整（例如扫描版 PDF 缺少文字层），需要向用户提示。 */
  warning?: string;
};

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index <= 0 || index === fileName.length - 1 ? '' : fileName.slice(index).toLowerCase();
}

/** 块间以空行连接，标题路径转成 markdown 标题行；块内文本原样保留，评分证据的逐字引用仍是正文的子串。 */
export function blocksToMarkdown(blocks: DocumentBlock[]): string {
  const sorted = [...blocks].sort((left, right) => left.seq - right.seq);
  const parts: string[] = [];
  for (const block of sorted) {
    const body = block.text.trim();
    if (!body) continue;
    const heading = block.headingPath?.filter(Boolean).length ? `## ${block.headingPath!.filter(Boolean).join(' › ')}\n\n` : '';
    parts.push(`${heading}${body}`);
  }
  return parts.join('\n\n');
}

function truncate(text: string): ExtractedTaskFileText {
  if (text.length <= MAX_TASK_FILE_TEXT_CHARS) return { text };
  return { text: `${text.slice(0, MAX_TASK_FILE_TEXT_CHARS)}\n\n${TASK_FILE_TEXT_TRUNCATION_NOTE}`, warning: `正文超过 ${MAX_TASK_FILE_TEXT_CHARS} 字符，已截断保留开头部分。` };
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

/**
 * 登记任务成果前从文件提取正文（默认行为）。返回 null 表示该类型不提取或解析失败：
 * 登记流程必须继续（文件本身仍是成果），由调用方提示用户材料检查将读不到正文。
 */
export async function extractTaskFileText(file: File): Promise<ExtractedTaskFileText | null> {
  const extension = extensionOf(file.name);
  try {
    if (TEXT_EXTENSIONS.includes(extension)) return truncate((await readAsText(file)).replace(/\r\n?/g, '\n'));
    if (!PARSEABLE_EXTENSIONS.includes(extension)) return null;
    const blocks: DocumentBlock[] = [];
    const result = await parseBrowserDocument(file, { onBatch: batch => { blocks.push(...batch.blocks); } });
    const markdown = blocksToMarkdown(blocks).replace(/\r\n?/g, '\n');
    if (!markdown.trim()) {
      return { text: '', warning: '未能从文件中提取到文字内容' + (result.warnings.length ? `（${result.warnings[0]!.message}）` : '') };
    }
    const extracted = truncate(markdown);
    const warning = result.status === 'partial' ? `文件解析不完整：${result.warnings[0]?.message ?? '部分内容无法读取'}` : extracted.warning;
    return { text: extracted.text, ...(warning ? { warning } : {}) };
  } catch {
    return null;
  }
}
