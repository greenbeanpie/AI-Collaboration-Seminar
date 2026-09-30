import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

it('来源分页处理游标和同一时间戳，不丢失或重复来源', async () => {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const cookie = authCookie(owner.token);
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/sources`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'paste', title: `来源 ${index}`, text: '真实来源' }),
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { data: { sourceId: string } }).data.sourceId);
  }
  await env.DB.prepare('UPDATE sources SET created_at = ?1 WHERE project_id = ?2')
    .bind('2026-09-30T00:00:00.000Z', projectId).run();
  let cursor: string | null = null;
  const actual: string[] = [];
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const url = new URL(`${BASE}/api/v1/projects/${projectId}/sources?limit=2`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await SELF.fetch(url, { headers: { cookie } });
    expect(response.status).toBe(200);
    const page = ((await response.json()) as { data: { items: { sourceId: string }[]; nextCursor: string | null } }).data;
    actual.push(...page.items.map(item => item.sourceId));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(actual).toEqual(ids.sort().reverse());
});
