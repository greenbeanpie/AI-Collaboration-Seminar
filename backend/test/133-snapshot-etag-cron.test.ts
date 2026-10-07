import { expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../src/env';
import { snapshotEtag } from '../src/core/snapshot-etag';
import { scheduledGroups } from '../src/cron';
it('partitions production cron invocations without duplicating groups', () => {
  expect(scheduledGroups('* * * * *')).toEqual(['recovery']);
  expect(scheduledGroups('*/10 * * * *')).toEqual(['backfill']);
  expect(scheduledGroups('0 * * * *')).toEqual(['cleanup']);
  expect(scheduledGroups('0 3 * * *')).toEqual(['orphan']);
  expect(scheduledGroups('unknown')).toEqual([]);
  expect(scheduledGroups()).toHaveLength(4);
});
it('computes account-isolated validators excluding request IDs, after authorization', async () => {
  const app=new Hono<AppEnv>(); let allowed=true;
  app.use('*',snapshotEtag);
  app.get('/api/v1/projects',c=>{if(!allowed)return c.json({error:'denied'},403); c.set('user',{id:c.req.header('x-account')||'a'} as never); return c.json({data:{items:[]},requestId:crypto.randomUUID()});});
  const first=await app.request('/api/v1/projects'); const etag=first.headers.get('ETag')!;
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/); expect(first.headers.get('Cache-Control')).toBe('private, no-store');
  const unchanged=await app.request('/api/v1/projects',{headers:{'If-None-Match':etag}});
  expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
  expect((await app.request('/api/v1/projects',{headers:{'x-account':'b','If-None-Match':etag}})).status).toBe(200);
  allowed=false; const denied=await app.request('/api/v1/projects',{headers:{'If-None-Match':etag}});
  expect(denied.status).toBe(403); expect(denied.headers.has('ETag')).toBe(false);
});
