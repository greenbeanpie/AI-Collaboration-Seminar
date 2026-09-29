import { LIMITS } from './limits';

export interface Cursor {
  createdAt: string;
  id: string;
}

export interface Paging {
  cursor?: Cursor;
  limit: number;
}

export function parsePaging(query: { cursor?: string | undefined; limit?: string | undefined }): Paging {
  const rawLimit = Number.parseInt(query.limit ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, LIMITS.listMaxPageSize)
    : LIMITS.listDefaultPageSize;
  return { cursor: decodeCursor(query.cursor), limit };
}

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const b64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed === 'object' && parsed !== null &&
      'createdAt' in parsed && typeof parsed.createdAt === 'string' &&
      'id' in parsed && typeof parsed.id === 'string'
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // 非法游标按无游标处理
  }
  return undefined;
}

/** 基于游标构造下一页游标；调用方在取到 limit+1 条时传入第 limit+1 条的字段 */
export function nextCursor(page: { limit: number }, overflowRow?: { createdAt: string; id: string }): string | undefined {
  if (!overflowRow) return undefined;
  void page;
  return encodeCursor({ createdAt: overflowRow.createdAt, id: overflowRow.id });
}
