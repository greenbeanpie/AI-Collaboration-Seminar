import type { Env } from '../env';
import { AppError, invalidState, versionConflict } from '../core/errors';
import { newId, nowIso } from '../core/db';
import { loadResourcePolicy } from './resource-policy';

// Official references (metadata only; no S3 objects or resource mutations):
// https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/
// https://developers.cloudflare.com/r2/platform/metrics-analytics/
// https://developers.cloudflare.com/r2/reference/data-location/
// https://developers.cloudflare.com/r2/platform/limits/
const API = 'https://api.cloudflare.com/client/v4';
const APP_BUCKET = 'ai-office-files-production';
// FedRAMP is separately provisioned for Enterprise, not a public-account probe.
const JURISDICTIONS = ['default', 'eu', 'us'] as const;
type Jurisdiction = typeof JURISDICTIONS[number];
type Bucket = { name: string; jurisdiction: Jurisdiction; metricName: string };
type MonitorEnv = Omit<Env, 'CLOUDFLARE_API_TOKEN'> & { CLOUDFLARE_API_TOKEN?: string; RESOURCE_MONITOR_TOKEN?: string };
const monitorToken = (env: MonitorEnv) => env.RESOURCE_MONITOR_TOKEN || env.CLOUDFLARE_API_TOKEN;
type InventoryState = { external_checked_at: string | null; updated_at: string; scanning: number; ready: number };
export type ExternalStorageUsageResult = { refreshed: boolean; checkedAt: string | null; externalBytes: number };
const MAX_BUCKETS = 50, MAX_PAGES = 2, BATCH = 10, DEADLINE_MS = 20_000;
const MAX_RESPONSE_BYTES = 512 * 1024, HOUR = 3600_000, MAX_SNAPSHOT_AGE = 4 * HOUR;
// The documented metrics expose pending upload count, not a guaranteed byte total
// for its incomplete parts. Reserve the maximum object size for each such upload.
const PENDING_UPLOAD_BYTES = 5 * 1024 ** 4;
type Failure = 'configuration' | 'permission' | 'provider' | 'incomplete' | 'stale' | 'deadline';
function unavailable(category: Failure): AppError {
  return new AppError('INTERNAL', '其他存储桶用量核查未完成，原核查数据保留', 503, false, { storageUsageCheckRequired: true, category });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable('incomplete');
  return value as Record<string, unknown>;
}
function bytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable('incomplete');
  return value;
}
const boundedAdd = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

async function requestJson(url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal }); }
  catch { throw unavailable(signal.aborted ? 'deadline' : 'provider'); }
  if (response.status === 401 || response.status === 403) throw unavailable('permission');
  if (!response.ok) throw unavailable('provider');
  if (!response.body) throw unavailable('incomplete');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let length = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable('incomplete'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable(signal.aborted ? 'deadline' : 'incomplete');
  } finally { reader.releaseLock(); }
}

async function listBuckets(env: MonitorEnv, signal: AbortSignal): Promise<Bucket[]> {
  const buckets: Bucket[] = [], identities = new Set<string>();
  for (const jurisdiction of JURISDICTIONS) {
    let cursor: string | undefined; const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`);
      url.searchParams.set('per_page', '1000'); if (cursor) url.searchParams.set('cursor', cursor);
      const data = await requestJson(url.href, { headers: { Authorization: `Bearer ${monitorToken(env)}`, 'cf-r2-jurisdiction': jurisdiction } }, signal);
      if (data.success !== true || (Array.isArray(data.errors) && data.errors.length)) throw unavailable('provider');
      const listed = record(data.result).buckets;
      if (!Array.isArray(listed)) throw unavailable('incomplete');
      for (const value of listed) {
        const bucket = record(value), name = bucket.name;
        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(name)
          || bucket.jurisdiction !== undefined && bucket.jurisdiction !== jurisdiction) throw unavailable('incomplete');
        const metricName = jurisdiction === 'default' ? name : `${jurisdiction}_${name}`;
        if (identities.has(metricName)) throw unavailable('incomplete');
        identities.add(metricName); buckets.push({ name, jurisdiction, metricName });
        if (buckets.length > MAX_BUCKETS) throw unavailable('incomplete');
      }
      const info = data.result_info === undefined ? {} : record(data.result_info);
      if (info.cursor === undefined || info.cursor === null || info.cursor === '') { cursor = undefined; break; }
      if (typeof info.cursor !== 'string' || seenCursors.has(info.cursor) || page === MAX_PAGES - 1) throw unavailable('incomplete');
      cursor = info.cursor; seenCursors.add(cursor);
    }
  }
  return buckets;
}

async function collect(env: MonitorEnv, signal: AbortSignal): Promise<{ externalBytes: number; checkedAt: string }> {
  const start = Date.now(), buckets = await listBuckets(env, signal);
  if (!buckets.some(bucket => bucket.jurisdiction === 'default' && bucket.name === APP_BUCKET)) throw unavailable('configuration');
  const external = buckets.filter(bucket => !(bucket.jurisdiction === 'default' && bucket.name === APP_BUCKET));
  let externalBytes = 0, observedAt = start;
  for (let offset = 0; offset < external.length; offset += BATCH) {
    const batch = external.slice(offset, offset + BATCH);
    const definitions = batch.map((_, i) => `$bucket${i}: string!`).join(',');
    const fields = batch.map((_, i) => `b${i}: r2StorageAdaptiveGroups(limit: 1, filter: {bucketName: $bucket${i}, datetime_geq: $since, datetime_leq: $until}, orderBy: [datetime_DESC]) { max {payloadSize metadataSize objectCount uploadCount} dimensions {datetime} }`).join('\n');
    const query = `query ExternalR2Usage($accountTag: string!, $since: Time!, $until: Time!, ${definitions}) {viewer {accounts(filter: {accountTag: $accountTag}) {${fields}}}}`;
    const variables: Record<string, string> = { accountTag: env.CLOUDFLARE_ACCOUNT_ID, since: new Date(start - 24 * HOUR).toISOString(), until: new Date(start).toISOString() };
    batch.forEach((bucket, i) => { variables[`bucket${i}`] = bucket.metricName; });
    const data = await requestJson(`${API}/graphql`, { method: 'POST', headers: { Authorization: `Bearer ${monitorToken(env)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }, signal);
    if (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length)) throw unavailable('provider');
    const accounts = record(record(data.data).viewer).accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw unavailable('incomplete');
    const account = record(accounts[0]);
    for (let i = 0; i < batch.length; i++) {
      const rows = account[`b${i}`]; if (!Array.isArray(rows) || rows.length !== 1) throw unavailable('incomplete');
      const row = record(rows[0]), metrics = record(row.max), timestamp = record(row.dimensions).datetime;
      const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(time) || time > start + 300_000 || start - time > MAX_SNAPSHOT_AGE) throw unavailable('stale');
      observedAt = Math.min(observedAt, time);
      bytes(metrics.objectCount);
      externalBytes = boundedAdd(externalBytes, boundedAdd(bytes(metrics.payloadSize), bytes(metrics.metadataSize)));
      externalBytes = boundedAdd(externalBytes, Math.min(Number.MAX_SAFE_INTEGER, bytes(metrics.uploadCount) * PENDING_UPLOAD_BYTES));
    }
  }
  // A second bounded listing detects creations/deletions while metrics are sampled.
  const after = await listBuckets(env, signal);
  const fingerprint = (items: Bucket[]) => items.map(bucket => bucket.metricName).sort().join('\n');
  if (fingerprint(after) !== fingerprint(buckets) || signal.aborted) throw unavailable(signal.aborted ? 'deadline' : 'incomplete');
  return { externalBytes, checkedAt: new Date(observedAt).toISOString() };
}

/** Hourly metadata refresh. Force is for an authenticated operator, never an automatic ready flag. */
export async function refreshExternalStorageUsage(env: MonitorEnv, force = false): Promise<ExternalStorageUsageResult> {
  const policy = await loadResourcePolicy(env);
  const state = await env.DB.prepare('SELECT external_checked_at,updated_at,scanning,ready FROM storage_inventory_state WHERE id=1').first<InventoryState>();
  if (!force && !monitorToken(env)) return { refreshed: false, checkedAt: state?.external_checked_at ?? null, externalBytes: policy.externalStorageBytes };
  if (!state || state.scanning) throw invalidState('应用桶盘点进行中，请在盘点结束后核查其他桶');
  if (!force && (env.ENV_NAME !== 'production' || state.external_checked_at && Date.now() - Date.parse(state.updated_at) < HOUR)) return { refreshed: false, checkedAt: state.external_checked_at, externalBytes: policy.externalStorageBytes };
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !monitorToken(env)) throw unavailable('configuration');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  let measured: Awaited<ReturnType<typeof collect>>;
  try { measured = await collect(env, controller.signal); } finally { clearTimeout(timer); }
  if (state.external_checked_at && measured.checkedAt < state.external_checked_at) throw unavailable('stale');
  const now = nowIso();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE resource_policy SET policy_json=json_set(policy_json,'$.externalStorageBytes',?2),version=version+1,updated_at=?3
      WHERE id=1 AND version=?1 AND EXISTS(SELECT 1 FROM storage_inventory_state WHERE id=1 AND scanning=0 AND external_checked_at IS ?4 AND updated_at=?5 AND ready=?6)`)
      .bind(policy.version, measured.externalBytes, now, state.external_checked_at, state.updated_at, state.ready),
    env.DB.prepare('UPDATE storage_inventory_state SET external_checked_at=?1,verification_note=?2,updated_at=?3 WHERE id=1 AND changes()=1 AND external_checked_at IS ?4 AND updated_at=?5')
      .bind(measured.checkedAt, 'Cloudflare R2 metadata; pending uploads reserved at the documented object-size ceiling', now, state.external_checked_at, state.updated_at),
    env.DB.prepare('INSERT INTO resource_policy_audit SELECT ?1,NULL,version,policy_json,?2 FROM resource_policy WHERE id=1 AND changes()=1').bind(newId(), now),
  ]);
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw versionConflict((await loadResourcePolicy(env)).version);
  return { refreshed: true, ...measured };
}
