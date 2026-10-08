export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/** Per-call error factories keep each caller's existing code and message semantics. */
export type PageContract = {
  missingItems: () => Error;
  repeatedCursor: () => Error;
  limitExceeded: () => Error;
  maxPages: number;
  requireNextCursor?: boolean;
  missingCursor?: () => Error;
  invalidCursor?: () => Error;
};

type PageShape = { items?: unknown; nextCursor?: unknown };

/**
 * Validates one list page without normalizing away caller-specific errors.
 * A missing nextCursor is terminal unless requireNextCursor is set; a malformed
 * cursor is terminal unless invalidCursor is provided.
 */
export function assertPage<T>(
  page: unknown,
  contract: Pick<PageContract, 'missingItems' | 'requireNextCursor' | 'missingCursor' | 'invalidCursor'>,
): CursorPage<T> {
  if (!page || typeof page !== 'object' || !Array.isArray((page as PageShape).items)) throw contract.missingItems();
  const candidate = page as { items: T[]; nextCursor?: unknown };
  if (!Object.prototype.hasOwnProperty.call(candidate, 'nextCursor')) {
    if (contract.requireNextCursor) throw (contract.missingCursor ?? contract.missingItems)();
    return { items: candidate.items, nextCursor: null };
  }
  if (candidate.nextCursor === null || candidate.nextCursor === undefined || candidate.nextCursor === '') return { items: candidate.items, nextCursor: null };
  if (typeof candidate.nextCursor !== 'string') {
    if (contract.invalidCursor) throw contract.invalidCursor();
    return { items: candidate.items, nextCursor: null };
  }
  return { items: candidate.items, nextCursor: candidate.nextCursor };
}

/** Follows nextCursor up to maxPages, rejecting repeated cursors instead of returning partial data. */
export async function iteratePages<T>(
  loadPage: (cursor: string | null) => Promise<unknown>,
  contract: PageContract,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageCount = 0; pageCount < contract.maxPages; pageCount += 1) {
    const page: CursorPage<T> = assertPage<T>(await loadPage(cursor), contract);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) throw contract.repeatedCursor();
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw contract.limitExceeded();
}
