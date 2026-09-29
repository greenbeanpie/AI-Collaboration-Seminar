/**
 * Markdown ↔ Tiptap JSON 转换（纯函数，无 IO，可单测）。
 * AI 产物统一以 Markdown 生成（模型输出更稳定），采纳/保存时转换为 Tiptap doc；
 * 导出时反向转换。仅支持计划内基础节点：标题/段落/有序无序列表/引用 + 基础行内标记。
 */

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
}

export type TiptapDoc = TiptapNode & { type: 'doc' };

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const ORDERED_RE = /^(\d+)[.、)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const INLINE_RE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;

function inlineToNodes(text: string): TiptapNode[] {
  // 极简行内解析：**粗体**、*斜体*、`代码`；其余为纯文本
  const nodes: TiptapNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[2] !== undefined) nodes.push({ type: 'text', text: m[2], marks: [{ type: 'bold' }] });
    else if (m[4] !== undefined) nodes.push({ type: 'text', text: m[4], marks: [{ type: 'italic' }] });
    else if (m[6] !== undefined) nodes.push({ type: 'text', text: m[6], marks: [{ type: 'code' }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes.length > 0 ? nodes : [{ type: 'text', text }];
}

/** Markdown → Tiptap doc。空输入返回空 doc。 */
export function markdownToDoc(markdown: string): TiptapDoc {
  const content: TiptapNode[] = [];
  const lines = (markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  type ListState = { type: 'bulletList' | 'orderedList'; items: string[] } | null;
  let list: ListState = null;

  const flushList = () => {
    if (!list) return;
    content.push({
      type: list.type,
      content: list.items.map((itemText) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: inlineToNodes(itemText) }],
      })),
    });
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = line.match(HEADING_RE);
    const bullet = line.match(BULLET_RE);
    const ordered = line.match(ORDERED_RE);
    const quote = line.match(QUOTE_RE);

    if (bullet) {
      if (list?.type !== 'bulletList') {
        flushList();
        list = { type: 'bulletList', items: [] };
      }
      list.items.push(bullet[1] ?? '');
      continue;
    }
    if (ordered) {
      if (list?.type !== 'orderedList') {
        flushList();
        list = { type: 'orderedList', items: [] };
      }
      list.items.push(ordered[2] ?? '');
      continue;
    }
    flushList();

    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: (heading[1] ?? '#').length },
        content: inlineToNodes(heading[2] ?? ''),
      });
    } else if (quote) {
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineToNodes(quote[1] ?? '') }] });
    } else if (line.trim().length > 0) {
      content.push({ type: 'paragraph', content: inlineToNodes(line.trim()) });
    }
    // 空行仅为段落分隔，跳过
  }
  flushList();
  return { type: 'doc', content };
}

function nodeText(node: TiptapNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(nodeText).join('');
}

function inlineMarkdown(node: TiptapNode): string {
  if (node.type === 'text') {
    let text = node.text ?? '';
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = `**${text}**`;
      else if (mark.type === 'italic') text = `*${text}*`;
      else if (mark.type === 'code') text = `\`${text}\``;
      else if (mark.type === 'link') text = `[${text}](${(mark.attrs?.['href'] as string) ?? ''})`;
    }
    return text;
  }
  return (node.content ?? []).map(inlineMarkdown).join('');
}

/** Tiptap doc → Markdown（导出用）。非法输入返回空串。 */
export function docToMarkdown(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return '';
  const root = doc as TiptapNode;
  if (root.type !== 'doc' || !Array.isArray(root.content)) return '';
  const out: string[] = [];
  for (const node of root.content) {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.['level'] ?? 1), 1), 3);
        out.push(`${'#'.repeat(level)} ${inlineMarkdown(node)}`);
        break;
      }
      case 'paragraph':
        out.push(inlineMarkdown(node));
        break;
      case 'blockquote':
        for (const child of node.content ?? []) {
          if (child.type === 'paragraph') out.push(`> ${inlineMarkdown(child)}`);
        }
        break;
      case 'bulletList':
        for (const item of node.content ?? []) {
          out.push(`- ${nodeText(item)}`);
        }
        break;
      case 'orderedList':
        node.content?.forEach((item, i) => out.push(`${i + 1}. ${nodeText(item)}`));
        break;
      default:
        break;
    }
  }
  return out.join('\n\n');
}

/** 校验客户端提交的 Tiptap doc 基本形状（宽松：仅约束根节点） */
export function isTiptapDoc(value: unknown): value is TiptapDoc {
  return (
    typeof value === 'object' && value !== null &&
    (value as TiptapNode).type === 'doc' &&
    Array.isArray((value as TiptapNode).content)
  );
}
