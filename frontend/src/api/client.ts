import type { ApiFailure, ApiEnvelope, DataOf, SchemaName } from './types';
import { errorMessage } from './error-info';
import { forgetAccount, offlineAccount, readCachedList, readSnapshot, rememberAccount, writeSnapshot } from '../offline/store';
import { cacheable, offlineView, queueOffline, seedLocalEntity } from '../offline/queue';
import { beginDesktopActivity } from '../desktop/lifecycle';
import { isDesktop } from '../desktop/bridge';

export class ApiError extends Error {
  readonly diagnosticMessage: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly stage?: string;
  readonly action?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, failure: ApiFailure) {
    super(failure.error.message);
    this.name = 'ApiError';
    this.diagnosticMessage = failure.error.message;
    this.status = status;
    this.code = failure.error.code ?? 'UNKNOWN_ERROR';
    this.requestId = failure.requestId ?? failure.error.requestId ?? '';
    this.retryable = failure.error.retryable ?? false;
    this.stage = failure.error.stage;
    this.action = failure.error.action;
    this.details = failure.error.details;
  }
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  idempotencyKey?: string;
  rawBody?: BodyInit;
  /** Internal sync/revalidation path: never read a local snapshot or enqueue work. */
  networkOnly?: boolean;
  requireOfflinePersistence?: boolean;
  /** Background conditional request bound to the originating account snapshot. */
  conditionalSnapshot?: { accountId: string; data: unknown; etag?: string };
};

function makeRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const revalidations = new Map<string, Promise<void>>();
const accountEpochs = new Map<string, number>();
if (typeof window !== 'undefined') window.addEventListener('account-device-cleared', event => {
  const accountId = (event as CustomEvent<{ accountId: string }>).detail?.accountId;
  if (typeof accountId === 'string') accountEpochs.set(accountId, (accountEpochs.get(accountId) ?? 0) + 1);
});
function revalidate(url: string, accountId: string): void {
  const key = `${accountId}:${url}`;
  if (revalidations.has(key)) return;
  const refresh = async () => {
    try {
      const previous = await readSnapshot(url, accountId);
      if (offlineAccount()?.id !== accountId) return;
      const data = await request(url, { networkOnly: true, signal: AbortSignal.timeout(15_000), ...(previous ? { conditionalSnapshot: { accountId, data: previous.data, etag: previous.etag } } : {}) });
      const sessionId = (data as { user?: { id?: string } }).user?.id;
      if (url === '/api/v1/auth/session' && sessionId && sessionId !== accountId && offlineAccount()?.id === sessionId) {
        window.dispatchEvent(new Event('auth-expired'));
        return;
      }
      const updated = await readSnapshot(url, accountId);
      if (offlineAccount()?.id === accountId && (!previous?.etag || !updated?.etag || previous.etag !== updated.etag)) {
        window.dispatchEvent(new CustomEvent('offline-snapshot-updated', { detail: { accountId } }));
      }
    } catch { /* Keep the visible snapshot when background refresh is unavailable. */ }
  };
  const pending = refresh().finally(() => { revalidations.delete(key); });
  revalidations.set(key, pending);
}

export function apiUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.startsWith('/api') ? path : `/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export async function request<Name extends SchemaName>(path: string, options: RequestOptions = {}): Promise<DataOf<Name>> {
  const finish = beginDesktopActivity();
  try { return await performRequest<Name>(path, options); }
  finally { finish(); }
}

async function performRequest<Name extends SchemaName>(path: string, options: RequestOptions): Promise<DataOf<Name>> {
  const method = options.method ?? 'GET';
  const requestId = makeRequestId();
  const url = apiUrl(path, options.query);
  const accountAtStart = offlineAccount()?.id;
  const epochAtStart = accountAtStart ? accountEpochs.get(accountAtStart) ?? 0 : 0;
  const submission = url.match(/^\/api\/v1\/projects\/([^/]+)\/(?:collaboration\/)?tasks\/([^/]+)\/submissions$/);
  if (submission && method === 'POST' && !options.networkOnly && isDesktop()) {
    const { hasPendingTaskFiles } = await import('../desktop/attachments');
    const pending = await hasPendingTaskFiles(submission[1]!, submission[2]!);
    if (offlineAccount()?.id !== accountAtStart || (accountAtStart && (accountEpochs.get(accountAtStart) ?? 0) !== epochAtStart)) {
      throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '本机账号数据已清除，请重新登录后操作。', retryable: false } });
    }
    if (pending) return await queueOffline(url, method, options.body, options.idempotencyKey) as DataOf<Name>;
  }
  const local = async (): Promise<DataOf<Name>> => {
    const cached = cacheable(url) ? await readSnapshot(url) : undefined;
    if (cached) return await offlineView(url, cached.data) as DataOf<Name>;
    const list = cacheable(url) ? await readCachedList(url) : undefined;
    if (list) return await offlineView(url, list) as DataOf<Name>;
    const entity = await seedLocalEntity(url);
    if (entity) return entity as DataOf<Name>;
    throw new ApiError(0, { requestId, error: { code: 'OFFLINE_NOT_CACHED', message: '此内容尚未保存到本机，请联网打开后再离线使用。', retryable: false } });
  };
  if (method === 'GET' && !options.networkOnly && accountAtStart && cacheable(url)) {
    try {
      const cached = await local();
      if (offlineAccount()?.id === accountAtStart) {
        if (navigator.onLine !== false) revalidate(url, accountAtStart);
        return cached;
      }
    } catch { /* A cache miss/storage failure must not prevent an online request. */ }
  }
  if (!options.networkOnly && navigator.onLine === false) {
    if (method === 'GET') return local();
    try { return await queueOffline(url, method, options.body, options.idempotencyKey) as DataOf<Name>; }
    catch (error) { throw new ApiError(0, { requestId, error: { code: 'OFFLINE_WRITE_FAILED', message: error instanceof Error ? error.message : '离线保存失败', retryable: false } }); }
  }
  const headers = new Headers(options.headers);
  headers.set('X-Request-Id', requestId);
  if (method === 'GET' && options.conditionalSnapshot && options.conditionalSnapshot.accountId === accountAtStart && options.conditionalSnapshot.etag) headers.set('If-None-Match', options.conditionalSnapshot.etag);
  const hasJsonBody = options.body !== undefined;
  if (hasJsonBody) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      cache: /^(?:\/api\/v1)?\/(?:jobs(?:\/|$)|creation-drafts(?:\/|$)|projects\/[^/]+\/ai\/clarifications(?:\/|$)|projects\/[^/]+\/collaboration\/proposals(?:\/|$)|profiles(?:\/|$)|support(?:\/|$)|admin\/accounts(?:\/|$)|auth(?:\/|$))/.test(path) ? 'no-store' : undefined,
      headers,
      body: options.rawBody ?? (hasJsonBody ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (method === 'GET' && !options.networkOnly && offlineAccount()) return local();
    throw new ApiError(0, {
      error: { code: 'NETWORK_ERROR', message: '无法连接服务，请检查网络或后端是否启动。', retryable: true, stage:'network',action:'check_connection' },
      requestId,
    });
  }

  if (accountAtStart && (accountEpochs.get(accountAtStart) ?? 0) !== epochAtStart) {
    throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '本机账号数据已清除，请重新登录后操作。', retryable: false } });
  }
  if (response.status === 304 && options.conditionalSnapshot?.etag && options.conditionalSnapshot.accountId === accountAtStart && offlineAccount()?.id === accountAtStart) return options.conditionalSnapshot.data as DataOf<Name>;
  const returnedRequestId = response.headers.get('X-Request-Id') ?? requestId;
  const responseText = await response.text();
  let payload: unknown = null;
  try { payload = JSON.parse(responseText); } catch { /* A plain-text backend reason is handled below. */ }
  const backendReason = errorMessage(payload, '') || (response.headers.get('Content-Type')?.startsWith('text/plain') ? responseText : '');
  if (!response.ok) {
    const failure = isApiFailure(payload)
      ? payload
      : {
          error: { code: `HTTP_${response.status}`, message: backendReason || '服务暂时无法处理该请求。', retryable: response.status >= 500 },
          requestId: returnedRequestId,
        } satisfies ApiFailure;
    if (response.status === 401) {
      forgetAccount();
      if (!path.endsWith('/auth/session')) window.dispatchEvent(new CustomEvent('auth-expired'));
    }
    throw new ApiError(response.status, failure);
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError(response.status, {
      error: { code: 'INVALID_RESPONSE', message: '服务返回了无法识别的响应。', retryable: false },
      requestId: returnedRequestId,
    });
  }
  const data = (payload as ApiEnvelope<DataOf<Name>>).data;
  // A late session response must not restore the previous identity after a switch/logout.
  if (method === 'GET' && url === '/api/v1/auth/session' && accountAtStart && offlineAccount()?.id !== accountAtStart) return data;
  if (/^\/api\/v1\/auth\/(?:session|sessions|register)$/.test(url)) {
    const user = (data as { user?: unknown }).user;
    if (user && typeof user === 'object' && 'id' in user) {
      try {
        const account = user as NonNullable<ReturnType<typeof offlineAccount>>;
        if (rememberAccount(account, method !== 'GET') === false) throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '本机账号数据已清除，请重新登录。', retryable: false } });
        if (method !== 'GET') await writeSnapshot('/api/v1/auth/session', { user: account }, account.id);
      }
      catch (error) { if (error instanceof ApiError) throw error; window.dispatchEvent(new Event('offline-storage-failed')); }
    }
  }
  const currentAccount = offlineAccount()?.id;
  if (method === 'GET' && cacheable(url) && currentAccount && (url === '/api/v1/auth/session' || currentAccount === accountAtStart)) {
    try { await writeSnapshot(url, data, currentAccount, response.headers.get('ETag') ?? undefined); }
    catch (failure) { window.dispatchEvent(new Event('offline-storage-failed')); if (options.requireOfflinePersistence) throw failure; }
    if (!options.networkOnly) {
      try { return await offlineView(url, data) as DataOf<Name>; }
      catch (error) { if (error instanceof ApiError) throw error; window.dispatchEvent(new Event('offline-storage-failed')); }
    }
  }
  return data;
}

export function isApiFailure(value: unknown): value is ApiFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ApiFailure>;
  return typeof candidate.error?.message === 'string';
}

export const api = {
  get: <Name extends SchemaName>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<Name>(path, { query, signal }),
  post: <Name extends SchemaName>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<Name>(path, { ...options, method: 'POST', body, idempotencyKey: options.idempotencyKey ?? makeRequestId() }),
  patch: <Name extends SchemaName>(path: string, body: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<Name>(path, { ...options, method: 'PATCH', body }),
  put: <Name extends SchemaName>(path: string, body: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<Name>(path, { ...options, method: 'PUT', body }),
  delete: <Name extends SchemaName>(path: string, options: Omit<RequestOptions, 'method'> = {}) =>
    request<Name>(path, { ...options, method: 'DELETE' }),
};

type ItemsOf<Name extends SchemaName> = DataOf<Name> extends { items: infer Items } ? Items : never;

export async function listAllItems<Name extends SchemaName>(
  path: string,
  query: RequestOptions['query'] = {},
  options: { requireNextCursor?: boolean; signal?: AbortSignal; networkOnly?: boolean } = {},
): Promise<ItemsOf<Name>> {
  const all: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    const page: DataOf<Name> = options.networkOnly
      ? await request<Name>(path, { query: { ...query, cursor }, signal: options.signal, networkOnly: true })
      : await api.get<Name>(path, { ...query, cursor }, options.signal);
    if (!page || typeof page !== 'object' || !('items' in page) || !Array.isArray(page.items)) {
      throw new ApiError(200, {
        error: { code: 'INVALID_PAGINATION', message: '服务端列表响应缺少 items 字段。', retryable: false },
        requestId: makeRequestId(),
      });
    }
    if (options.requireNextCursor && !('nextCursor' in page)) {
      throw new ApiError(200, {
        error: { code: 'INVALID_PAGINATION', message: '游标分页响应缺少 nextCursor 字段，无法确认列表是否完整。', retryable: false },
        requestId: makeRequestId(),
      });
    }
    all.push(...page.items);
    const nextCursor: string | null = 'nextCursor' in page && typeof page.nextCursor === 'string' ? page.nextCursor : null;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new ApiError(200, {
        error: { code: 'INVALID_PAGINATION', message: '服务端返回了重复分页游标，已停止加载以避免重复记录。', retryable: false },
        requestId: makeRequestId(),
      });
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
    pageCount += 1;
    if (pageCount > 200) {
      throw new ApiError(200, {
        error: { code: 'PAGINATION_LIMIT', message: '项目数据页数超出安全加载上限，请联系管理员。', retryable: false },
        requestId: makeRequestId(),
      });
    }
  } while (cursor);
  return all as ItemsOf<Name>;
}

export const projectPath = (projectId: string, tail = '') => `/api/v1/projects/${encodeURIComponent(projectId)}${tail}`;

/** Binary response paths share the API reason contract without exposing transport metadata. */
export async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload: unknown = await response.json().catch(() => null);
  if (isApiFailure(payload)) return new ApiError(response.status, payload);
  return new Error(errorMessage(payload, fallback));
}
