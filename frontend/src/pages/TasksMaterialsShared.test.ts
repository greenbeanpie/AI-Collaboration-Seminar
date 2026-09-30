import { describe, expect, it } from 'vitest';
import { loadCursorPages } from './TasksMaterialsShared';

describe('cursor-paged project data', () => {
  it('rejects a repeated cursor instead of silently treating partial data as complete', async () => {
    await expect(loadCursorPages(async () => ({ items: [], nextCursor: 'repeat' })))
      .rejects.toThrow('重复分页游标');
  });

  it('returns every page when the service finishes the cursor sequence', async () => {
    const cursors: Array<string | undefined> = [];
    const result = await loadCursorPages(async (cursor) => {
      cursors.push(cursor);
      return cursor
        ? { items: ['last'], nextCursor: null }
        : { items: ['first'], nextCursor: 'next-page' };
    });

    expect(result).toEqual(['first', 'last']);
    expect(cursors).toEqual([undefined, 'next-page']);
  });
});
