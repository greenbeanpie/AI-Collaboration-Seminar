import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { refreshExternalStorageUsage } from '../src/services/storage-external-usage';
import { loadResourcePolicy } from '../src/services/resource-policy';
import { reserveStorage, withManagedStorage } from '../src/services/managed-storage';
import { newId } from '../src/core/db';

const APP_BUCKET = 'ai-office-files-production';
const production = { ...env, ENV_NAME: 'production' as const, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'old-secret', RESOURCE_MONITOR_TOKEN: 'monitor-secret' };
const oldTime = '2026-01-01T00:00:00.000Z';
type Metric = { payloadSize: number; metadataSize: number; objectCount: number; uploadCount: number };
const metric = (payloadSize = 100): Metric => ({ payloadSize, metadataSize: 7, objectCount: 1, uploadCount: 0 });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
type ProviderOptions = {
  lists?: Record<string, string[]>;
  metrics?: Record<string, Partial<Metric>>;
  time?: string;
  beforeGraphql?: () => Promise<void>;
  alter?: (url: URL, init: RequestInit | undefined, ordinary: Response) => Response;
};
function provider(options: ProviderOptions = {}) {
  const lists = options.lists ?? { default: [APP_BUCKET, 'other-bucket'], eu: [APP_BUCKET], us: [] };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer monitor-secret');
    expect(init?.redirect).toBe('error');
    let response: Response;
    if (url.pathname.endsWith('/r2/buckets')) {
      expect(init?.method ?? 'GET').toBe('GET');
      const jurisdiction = new Headers(init?.headers).get('cf-r2-jurisdiction')!;
      expect(['default', 'eu', 'us']).toContain(jurisdiction);
      response = json({ success: true, errors: [], result: { buckets: lists[jurisdiction]!.map(name => ({ name, jurisdiction })) } });
    } else {
      expect(url.pathname).toBe('/client/v4/graphql');
      expect(init?.method).toBe('POST');
      await options.beforeGraphql?.();
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, string>; query: string };
      expect(body.query).toContain('r2StorageAdaptiveGroups');
      const account: Record<string, unknown> = {};
      for (const [key, bucket] of Object.entries(body.variables)) if (key.startsWith('bucket')) {
        account[`b${key.slice(6)}`] = [{ max: { ...metric(), ...options.metrics?.[bucket] }, dimensions: { datetime: options.time ?? new Date(Date.now() - 1000).toISOString() } }];
      }
      response = json({ data: { viewer: { accounts: [account] } } });
    }
    return options.alter?.(url, init, response) ?? response;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function state() {
  return {
    policy: await loadResourcePolicy(env),
    inventory: await env.DB.prepare('SELECT * FROM storage_inventory_state WHERE id=1').first(),
    audit: (await env.DB.prepare('SELECT * FROM resource_policy_audit ORDER BY version').all()).results,
  };
}
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM storage_reservations'), env.DB.prepare('DELETE FROM storage_objects'),
    env.DB.prepare('DELETE FROM resource_policy_audit'),
    env.DB.prepare("UPDATE resource_policy SET version=1,policy_json=json_set(policy_json,'$.externalStorageBytes',12),updated_at=?1 WHERE id=1").bind(oldTime),
    env.DB.prepare('UPDATE storage_inventory_state SET ready=0,scanning=0,external_checked_at=?1,updated_at=?1,verification_note=NULL WHERE id=1').bind(oldTime),
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded external R2 metadata refresh', () => {
  it('counts all public jurisdictions and pending uploads, excludes only the known default app bucket, and preserves readiness', async () => {
    const time = new Date(Date.now() - 1000).toISOString();
    const fetch = provider({ time, metrics: { 'other-bucket': { payloadSize: 1000 }, [`eu_${APP_BUCKET}`]: { payloadSize: 2000 } } });
    const result = await refreshExternalStorageUsage(production, true);
    expect(result).toEqual({ refreshed: true, checkedAt: time, externalBytes: 3014 });
    expect(fetch).toHaveBeenCalledTimes(7);
    const next = await state();
    expect(next.policy).toMatchObject({ version: 2, externalStorageBytes: 3014 });
    expect(next.inventory).toMatchObject({ ready: 0, external_checked_at: time });
    expect(next.audit).toHaveLength(1);
    expect(next.audit[0]).toMatchObject({ actor_id: null, version: 2 });
    expect(await refreshExternalStorageUsage(production)).toEqual({ ...result, refreshed: false });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect((await loadResourcePolicy(env)).version).toBe(2);
  });

  it('proves zero from complete metadata lists without querying or inspecting objects', async () => {
    const fetch = provider({ lists: { default: [APP_BUCKET], eu: [], us: [] } });
    expect(await refreshExternalStorageUsage(production, true)).toMatchObject({ refreshed: true, externalBytes: 0 });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('retains manual inventory silently without credentials, while operator force reports missing configuration', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const manual = { ...production, RESOURCE_MONITOR_TOKEN: undefined, CLOUDFLARE_API_TOKEN: undefined };
    const before = await state();
    expect(await refreshExternalStorageUsage(manual)).toEqual({ refreshed: false, checkedAt: oldTime, externalBytes: 12 });
    await expect(refreshExternalStorageUsage(manual, true)).rejects.toMatchObject({ status: 503, details: { category: 'configuration' } });
    expect(fetch).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it('supports the existing token when a dedicated monitor token is absent', async () => {
    provider();
    expect(await refreshExternalStorageUsage({ ...production, RESOURCE_MONITOR_TOKEN: undefined, CLOUDFLARE_API_TOKEN: 'monitor-secret' }, true)).toMatchObject({ refreshed: true });
  });

  it.each([
    ['permission', () => new Response('private supplier diagnostic monitor-secret', { status: 403 }), 'permission'],
    ['malformed json', () => new Response('{'), 'incomplete'],
    ['provider failure', () => json({ success: false, errors: [{ message: 'monitor-secret' }] }), 'provider'],
    ['body bound', () => new Response(' '.repeat(512 * 1024 + 1)), 'incomplete'],
  ] as const)('leaves policy, inventory and audit unchanged on %s', async (_, alter, category) => {
    const before = await state(); provider({ alter });
    const failure = await refreshExternalStorageUsage(production, true).catch(error => error);
    expect(failure).toMatchObject({ code: 'INTERNAL', status: 503, details: { category } });
    expect(JSON.stringify(failure)).not.toContain('secret'); expect(failure.message).not.toContain('secret');
    expect(await state()).toEqual(before);
  });

  it('does not ignore denied public-jurisdiction visibility', async () => {
    const before = await state();
    provider({ alter: (_, init, ordinary) => new Headers(init?.headers).get('cf-r2-jurisdiction') === 'eu' ? new Response(null, { status: 403 }) : ordinary });
    await expect(refreshExternalStorageUsage(production, true)).rejects.toMatchObject({ details: { category: 'permission' } });
    expect(await state()).toEqual(before);
  });

  it('sanitizes network failure and retains prior evidence', async () => {
    const before = await state();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('upstream diagnostic monitor-secret'); }));
    const failure = await refreshExternalStorageUsage(production, true).catch(error => error);
    expect(failure).toMatchObject({ status: 503, details: { category: 'provider' } });
    expect(failure.message + JSON.stringify(failure)).not.toContain('secret');
    expect(await state()).toEqual(before);
  });

  it('requires the configured app bucket and never turns missing visibility into zero usage', async () => {
    const before = await state(); provider({ lists: { default: [], eu: [], us: [] } });
    await expect(refreshExternalStorageUsage(production, true)).rejects.toMatchObject({ details: { category: 'configuration' } });
    expect(await state()).toEqual(before);
  });

  it.each(['missing metrics', 'stale metrics', 'invalid metric', 'bucket set changed', 'bucket limit', 'pagination incomplete'] as const)('rejects %s without replacing previous evidence', async reason => {
    const before = await state(); let listCalls = 0;
    provider({
      ...(reason === 'stale metrics' ? { time: new Date(Date.now() - 5 * 3600_000).toISOString() } : {}),
      ...(reason === 'invalid metric' ? { metrics: { 'other-bucket': { payloadSize: -1 } } } : {}),
      ...(reason === 'bucket limit' ? { lists: { default: [APP_BUCKET, ...Array.from({ length: 50 }, (_, i) => `bucket-${i}`)], eu: [], us: [] } } : {}),
      alter: (url, _init, ordinary) => {
        if (reason === 'missing metrics' && url.pathname.endsWith('/graphql')) return json({ data: { viewer: { accounts: [{ b0: [], b1: [] }] } } });
        if (url.pathname.endsWith('/buckets')) {
          listCalls++;
          if (reason === 'bucket set changed' && listCalls === 4) return json({ success: true, result: { buckets: [{ name: APP_BUCKET }, { name: 'new-bucket' }] } });
          if (reason === 'pagination incomplete') return json({ success: true, result: { buckets: [] }, result_info: { cursor: 'repeat' } });
        }
        return ordinary;
      },
    });
    await expect(refreshExternalStorageUsage(production, true)).rejects.toMatchObject({ status: 503 });
    expect(await state()).toEqual(before);
  });

  it('handles bounded pagination and metrics batches for a complete scan', async () => {
    const buckets = Array.from({ length: 12 }, (_, i) => `bucket-${i}`);
    const fetch = provider({ lists: { default: [APP_BUCKET, ...buckets], eu: [], us: [] }, alter: (url, init, ordinary) => {
      if (url.pathname.endsWith('/buckets') && new Headers(init?.headers).get('cf-r2-jurisdiction') === 'default') {
        const page = url.searchParams.get('cursor');
        return json({ success: true, result: { buckets: (page ? buckets.slice(6) : [APP_BUCKET, ...buckets.slice(0, 6)]).map(name => ({ name })) }, ...(page ? {} : { result_info: { cursor: 'page2' } }) });
      }
      return ordinary;
    } });
    expect(await refreshExternalStorageUsage(production, true)).toMatchObject({ externalBytes: 12 * 107 });
    expect(fetch).toHaveBeenCalledTimes(10); // 4 list pages twice and 2 metric batches.
  });

  it.each(['policy', 'inventory'] as const)('does not overwrite a concurrent %s change', async target => {
    let changed = false;
    provider({ beforeGraphql: async () => {
      if (changed) return; changed = true;
      if (target === 'policy') await env.DB.prepare("UPDATE resource_policy SET version=2,policy_json=json_set(policy_json,'$.externalStorageBytes',999) WHERE id=1").run();
      else await env.DB.prepare('UPDATE storage_inventory_state SET scanning=1 WHERE id=1').run();
    } });
    await expect(refreshExternalStorageUsage(production, true)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const result = await state();
    expect(result.policy.externalStorageBytes).toBe(target === 'policy' ? 999 : 12);
    expect(result.inventory).toMatchObject({ external_checked_at: oldTime, scanning: target === 'inventory' ? 1 : 0 });
    expect(result.audit).toHaveLength(0);
  });

  it.each(['over platform', 'pending multipart'] as const)('retains originals and rejects only growth when %s is measured', async reason => {
    const key = `existing/${newId()}.txt`;
    await env.FILES.put(key, 'original');
    await env.DB.prepare("INSERT INTO storage_objects(object_key,size_bytes,category,updated_at) VALUES(?1,8,'system',?2)").bind(key, oldTime).run();
    provider({ lists: { default: [APP_BUCKET, 'other-bucket'], eu: [], us: [] }, metrics: { 'other-bucket': reason === 'pending multipart' ? { uploadCount: 1 } : { payloadSize: 11_000_000_000 } } });
    const result = await refreshExternalStorageUsage(production, true);
    expect(result.externalBytes).toBeGreaterThan(10_000_000_000);
    if (reason === 'pending multipart') expect(result.externalBytes).toBe(10_000 * 5 * 1024 ** 3 + 107);
    await env.DB.prepare('UPDATE storage_inventory_state SET ready=1 WHERE id=1').run();
    await expect(reserveStorage(production, `new/${newId()}.txt`, 1, 'put', { category: 'system' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await (await env.FILES.get(key))!.text()).toBe('original');
    expect(await env.DB.prepare('SELECT size_bytes FROM storage_objects WHERE object_key=?1').bind(key).first()).toEqual({ size_bytes: 8 });
    await withManagedStorage(production).FILES.delete(key);
    expect(await env.FILES.head(key)).toBeNull(); // Confirmed deletion remains possible while over quota.
  });

  it('aborts stalled provider I/O at the bounded deadline and retains prior data', async () => {
    const before = await state(); vi.useFakeTimers();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true })));
    vi.stubGlobal('fetch', fetch);
    const result = refreshExternalStorageUsage(production, true).catch(error => error);
    // D1 reads must finish before advancing the provider timeout.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled(), { interval: 10, timeout: 1000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ status: 503, details: { category: 'deadline' } });
    vi.useRealTimers(); expect(await state()).toEqual(before);
  });
});
