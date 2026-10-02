import { AppError } from '../core/errors';
export interface DocumentFragment {
    id: string;
    page_number: number | null;
    content: string;
    kind?: string;
}
export function renderDocumentChunk(fragments: DocumentFragment[], includeKind = false): string {
    return '<source>\n' + fragments.map(f => '[frag:' + f.id + ' 页' + (f.page_number ?? '-') + (includeKind ? ' ' + (f.kind ?? 'text') : '') + ']\n' + f.content).join('\n\n') + '\n</source>';
}
/** Partition every character. Oversized original fragments retain their ID for checked citations. */
export function documentChunks<T extends DocumentFragment>(fragments: T[], maxInputChars: number, systemChars: number, includeKind = false): T[][] {
    const capacity = maxInputChars - systemChars;
    const chunks: T[][] = [];
    let current: T[] = [];
    for (const fragment of fragments) {
        let offset = 0;
        do {
            const header = renderDocumentChunk([{ ...fragment, content: '' }], includeKind).length;
            const available = capacity - renderDocumentChunk(current, includeKind).length - (current.length ? 2 : 0) - header + '<source>\n\n</source>'.length;
            if (available < 1) {
                if (current.length) {
                    chunks.push(current);
                    current = [];
                    continue;
                }
                throw new AppError('SOURCE_PARSE_FAILED', '模型输入上限不足以容纳资料片段与提示词', 422, false);
            }
            let length = Math.min(fragment.content.length - offset, available);
            if (length > 0 && offset + length < fragment.content.length && /[\uD800-\uDBFF]/u.test(fragment.content[offset + length - 1]!))
                length--;
            if (length < 1 && fragment.content.length > offset) {
                if (current.length) { chunks.push(current); current = []; continue; }
                throw new AppError('SOURCE_PARSE_FAILED', '模型输入上限不足以容纳资料字符', 422, false);
            }
            const part = { ...fragment, content: fragment.content.slice(offset, offset + length) };
            current.push(part);
            offset += length;
            if (offset < fragment.content.length) {
                chunks.push(current);
                current = [];
            }
        } while (offset < fragment.content.length);
    }
    if (current.length)
        chunks.push(current);
    return chunks;
}
export function validateChunkCitations(fragments: DocumentFragment[], citations: {
    fragmentId: string;
    pageNumber: number | null;
    quote: string;
}[]): void {
    const normalize = (s: string) => s.replace(/\s+/gu, '').toLowerCase();
    for (const cite of citations) {
        if (!fragments.some(f => f.id === cite.fragmentId && f.page_number === cite.pageNumber && normalize(f.content).includes(normalize(cite.quote))))
            throw new AppError('AI_OUTPUT_INVALID', '引用不属于本次实际读取的原文片段', 502, false);
    }
}
