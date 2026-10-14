import type { ApiFailure, ApiEnvelope, DataOf, SchemaName } from './types';
import { errorMessage } from './error-info';
import { newId } from './ids';
import { iteratePages } from './page-contract';
import { forgetAccount, offlineAccount, readCachedList, readSnapshot, rememberAccount, writeSnapshot, projectEpoch, projectIdForUrl, projectRevoked, restoreProjectAccess, revokeProjectAccess } from '../offline/store';
import { cacheable, offlineView, queueOffline, seedLocalEntity } from '../offline/queue';
import { beginDesktopActivity } from '../desktop/lifecycle';
import { isDesktop } from '../desktop/bridge';
import { storageFailureMessage } from '../offline/storage-protection';

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
  /** A bounded transport deadline. GET defaults to 15 seconds; writes opt in explicitly. */
  timeoutMs?: number;
  /** Short control operations only; uploads and AI retain their independent deadlines. */
  shortControl?: boolean;
  idempotencyKey?: string;
  rawBody?: BodyInit;
  /** Internal sync/revalidation path: never read a local snapshot or enqueue work. */
  networkOnly?: boolean;
  /** Display-only network-first GET: allow an account-owned snapshot on transport failure, never HTTP failures. */
  offlineReadFallback?: boolean;
  requireOfflinePersistence?: boolean;
  /** Background conditional request bound to the originating account snapshot. */
  conditionalSnapshot?: { accountId: string; data: unknown; etag?: string };
};

function makeRequestId(): string {
  return newId();
}

const revalidations = new Map<string, Promise<void>>();
const accountEpochs = new Map<string, number>();
const accessChecks = new Map<string, Promise<void>>();
async function checkProjectFailure(url: string, accountId: string): Promise<void> {
  const projectId = projectIdForUrl(url);
  if (!projectId) return;
  const root = `/api/v1/projects/${projectId}`;
  if (new URL(url, window.location.origin).pathname === root) { await revokeProjectAccess(accountId, projectId); return; }
  const key = `${accountId}:${projectId}`;
  if (!accessChecks.has(key)) {
    const check = (async () => {
      try {
        await request(root, { networkOnly: true });
        if (offlineAccount()?.id === accountId) window.dispatchEvent(new CustomEvent('project-permissions-updated', { detail: { accountId, projectId } }));
      } catch { /* Root refusal handles revocation; transport failure does not prove loss of membership. */ }
    })().finally(() => accessChecks.delete(key));
    accessChecks.set(key, check);
  }
  await accessChecks.get(key);
}
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
      const changed = previous?.etag && updated?.etag
        ? previous.etag !== updated.etag
        : JSON.stringify(previous?.data) !== JSON.stringify(updated?.data);
      if (offlineAccount()?.id === accountId && updated && changed) {
        window.dispatchEvent(new CustomEvent('offline-snapshot-updated', { detail: { accountId, url } }));
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
  const projectId = projectIdForUrl(url);
  const projectFence = accountAtStart && projectId ? projectEpoch(accountAtStart, projectId) : 0;
  const startsSession = method === 'POST' && /^\/api\/v1\/auth\/(?:sessions|register)$/.test(url);
  const assertAccount = () => {
    if ((!startsSession && offlineAccount()?.id !== accountAtStart) || (accountAtStart && (accountEpochs.get(accountAtStart) ?? 0) !== epochAtStart)) {
      throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '账号或本机数据已变化，请重新打开当前页面后操作。', retryable: false } });
    }
    if (accountAtStart && projectId && projectEpoch(accountAtStart, projectId) !== projectFence) throw new ApiError(403, { requestId, error: { code: 'PROJECT_ACCESS_CHANGED', message: '项目权限已变更，本机修改已保留，请重新核对权限。', retryable: false } });
  };
  const submission = url.match(/^\/api\/v1\/projects\/([^/]+)\/(?:collaboration\/)?tasks\/([^/]+)\/submissions$/);
  if (submission && method === 'POST' && !options.networkOnly && isDesktop()) {
    const { hasPendingTaskFiles } = await import('../desktop/attachments');
    const pending = await hasPendingTaskFiles(submission[1]!, submission[2]!);
    if (offlineAccount()?.id !== accountAtStart || (accountAtStart && (accountEpochs.get(accountAtStart) ?? 0) !== epochAtStart)) {
      throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '本机账号数据已清除，请重新登录后操作。', retryable: false } });
    }
    if (pending) return await queueOffline(url, method, options.body, options.idempotencyKey, assertAccount) as DataOf<Name>;
  }
  const local = async (): Promise<DataOf<Name>> => {
    assertAccount();
    if (accountAtStart && projectId && projectRevoked(accountAtStart, projectId)) throw new ApiError(403, { requestId, error: { code: 'PROJECT_ACCESS_CHANGED', message: '项目权限已变更，原项目快照已隔离，本机修改保留。', retryable: false } });
    const cached = cacheable(url) ? await readSnapshot(url, accountAtStart) : undefined;
    const list = !cached && cacheable(url) ? await readCachedList(url, accountAtStart) : undefined;
    const value = cached ? await offlineView(url, cached.data) : list ? await offlineView(url, list) : await seedLocalEntity(url);
    assertAccount();
    if (value !== undefined) return value as DataOf<Name>;
    throw new ApiError(0, { requestId, error: { code: 'OFFLINE_NOT_CACHED', message: '此内容尚未保存到本机，请联网打开后再离线使用。', retryable: false } });
  };
  if (method === 'GET' && !options.networkOnly && accountAtStart && cacheable(url)) {
    try {
      const cached = await local();
      if (offlineAccount()?.id === accountAtStart) {
        if (navigator.onLine !== false) revalidate(url, accountAtStart);
        return cached;
      }
    } catch (error) { if (error instanceof ApiError && error.code === 'AUTH_CONTEXT_CHANGED') throw error; if (navigator.onLine === false && error instanceof ApiError && error.code === 'PROJECT_ACCESS_CHANGED') throw error; /* A cache miss/storage failure must not prevent an online request. */ }
  }
  if (!options.networkOnly && navigator.onLine === false) {
    if (method === 'GET') return local();
    try { return await queueOffline(url, method, options.body, options.idempotencyKey, assertAccount) as DataOf<Name>; }
    catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_CONTEXT_CHANGED') throw error;
      throw new ApiError(0, { requestId, error: { code: 'OFFLINE_WRITE_FAILED', message: error instanceof DOMException ? storageFailureMessage(error) : error instanceof Error ? error.message : '离线保存失败', retryable: false } });
    }
  }
  const headers = new Headers(options.headers);
  headers.set('X-Request-Id', requestId);
  if (method === 'GET' && options.conditionalSnapshot && options.conditionalSnapshot.accountId === accountAtStart && options.conditionalSnapshot.etag) headers.set('If-None-Match', options.conditionalSnapshot.etag);
  const hasJsonBody = options.body !== undefined;
  if (hasJsonBody) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

  let response: Response;
  let responseText: string;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? (method === 'GET' ? 15_000 : options.shortControl || /^\/api\/v1\/(?:auth\/(?:sessions|register|password|password-recovery\/redeem)|invitations\/(?:preview|accept)|creation-drafts(?:\/[^/]+(?:\/(?:commit|state))?)?)$/.test(url) ? 30_000 : undefined);
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('请求超时', 'TimeoutError'));
  }, timeoutMs);
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      cache: /^(?:\/api\/v1)?\/(?:jobs(?:\/|$)|creation-drafts(?:\/|$)|projects\/[^/]+\/ai\/clarifications(?:\/|$)|projects\/[^/]+\/collaboration\/proposals(?:\/|$)|profiles(?:\/|$)|support(?:\/|$)|admin\/accounts(?:\/|$)|auth(?:\/|$))/.test(path) ? 'no-store' : undefined,
      headers,
      body: options.rawBody ?? (hasJsonBody ? JSON.stringify(options.body) : undefined),
      signal: controller.signal,
    });
    assertAccount();
    responseText = await response.text();
    assertAccount();
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    assertAccount();
    if (error instanceof ApiError) throw error;
    if (!timedOut && error instanceof DOMException && error.name === 'AbortError') throw error;
    if (method === 'GET' && !options.networkOnly && accountAtStart) return local();
    if (method === 'GET' && options.offlineReadFallback && cacheable(url) && accountAtStart && offlineAccount()?.id === accountAtStart) return local();
    throw new ApiError(0, {
      error: { code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', message: timedOut ? method === 'GET' ? '读取服务超时，请检查网络后重试。' : '请求超时，服务端结果尚未确认；请先核对状态，再继续操作。' : '无法连接服务，请检查网络或后端是否启动。', retryable: true, stage:'network',action:'check_connection', ...(method !== 'GET' ? { details: { outcomeUnknown: true } } : {}) },
      requestId,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }

  if (accountAtStart && (accountEpochs.get(accountAtStart) ?? 0) !== epochAtStart) {
    throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '本机账号数据已清除，请重新登录后操作。', retryable: false } });
  }
  if (response.status === 304 && options.conditionalSnapshot?.etag && options.conditionalSnapshot.accountId === accountAtStart && offlineAccount()?.id === accountAtStart) return options.conditionalSnapshot.data as DataOf<Name>;
  const returnedRequestId = response.headers.get('X-Request-Id') ?? requestId;
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
    if (accountAtStart && projectId && [403, 404].includes(response.status)) {
      try { await checkProjectFailure(url, accountAtStart); }
      catch (error) { window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: error instanceof Error ? error.message : '项目快照清理失败，已停止显示。' } })); }
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
  if (method === 'GET' && accountAtStart && projectId && new URL(url, window.location.origin).pathname === `/api/v1/projects/${projectId}`) restoreProjectAccess(accountAtStart, projectId);
  let establishedSession: { accountId: string; epoch: number } | undefined;
  const assertResultAccount = () => {
    if (!establishedSession) { assertAccount(); return; }
    if (offlineAccount()?.id !== establishedSession.accountId || (accountEpochs.get(establishedSession.accountId) ?? 0) !== establishedSession.epoch || (accountAtStart && (accountEpochs.get(accountAtStart) ?? 0) !== epochAtStart)) {
      throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '账号或本机数据已变化，请重新打开当前页面后操作。', retryable: false } });
    }
  };
  // A late session response must not restore the previous identity after a switch/logout.
  if (method === 'GET' && url === '/api/v1/auth/session' && accountAtStart && offlineAccount()?.id !== accountAtStart) return data;
  if (/^\/api\/v1\/auth\/(?:session|sessions|register)$/.test(url)) {
    const user = (data as { user?: unknown }).user;
    if (user && typeof user === 'object' && 'id' in user) {
      try {
        const account = user as NonNullable<ReturnType<typeof offlineAccount>>;
        if (rememberAccount(account, method !== 'GET') === false) throw new ApiError(401, { requestId, error: { code: 'AUTH_CONTEXT_CHANGED', message: '本机账号数据已清除，请重新登录。', retryable: false } });
        establishedSession = { accountId: account.id, epoch: accountEpochs.get(account.id) ?? 0 };
        if (method !== 'GET') await writeSnapshot('/api/v1/auth/session', { user: account }, account.id);
        assertResultAccount();
      }
      catch (error) { if (error instanceof ApiError) throw error; window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: storageFailureMessage(error) } })); }
    }
  }
  const currentAccount = offlineAccount()?.id;
  if (method === 'GET' && cacheable(url) && currentAccount && (url === '/api/v1/auth/session' || currentAccount === accountAtStart)) {
    try { await writeSnapshot(url, data, currentAccount, response.headers.get('ETag') ?? undefined); }
    catch (failure) { window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: storageFailureMessage(failure) } })); if (options.requireOfflinePersistence) throw failure; }
    assertResultAccount();
    if (!options.networkOnly) {
      try { const view = await offlineView(url, data); assertResultAccount(); return view as DataOf<Name>; }
      catch (error) { if (error instanceof ApiError) throw error; window.dispatchEvent(new Event('offline-storage-failed')); }
    }
  }
  assertResultAccount();
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
  options: { requireNextCursor?: boolean; signal?: AbortSignal; networkOnly?: boolean; offlineReadFallback?: boolean } = {},
): Promise<ItemsOf<Name>> {
  const items = await iteratePages<unknown>(
    (cursor) => options.networkOnly
      ? request<Name>(path, { query: { ...query, cursor }, signal: options.signal, networkOnly: true, offlineReadFallback: options.offlineReadFallback })
      : api.get<Name>(path, { ...query, cursor }, options.signal),
    {
      missingItems: () => new ApiError(200, { error: { code: 'INVALID_PAGINATION', message: '服务端列表响应缺少 items 字段。', retryable: false }, requestId: makeRequestId() }),
      requireNextCursor: options.requireNextCursor,
      missingCursor: () => new ApiError(200, { error: { code: 'INVALID_PAGINATION', message: '游标分页响应缺少 nextCursor 字段，无法确认列表是否完整。', retryable: false }, requestId: makeRequestId() }),
      repeatedCursor: () => new ApiError(200, { error: { code: 'INVALID_PAGINATION', message: '服务端返回了重复分页游标，已停止加载以避免重复记录。', retryable: false }, requestId: makeRequestId() }),
      limitExceeded: () => new ApiError(200, { error: { code: 'PAGINATION_LIMIT', message: '项目数据页数超出安全加载上限，请联系管理员。', retryable: false }, requestId: makeRequestId() }),
      maxPages: 200,
    },
  );
  return items as ItemsOf<Name>;
}

export const projectPath = (projectId: string, tail = '') => `/api/v1/projects/${encodeURIComponent(projectId)}${tail}`;

/** Binary response paths share the API reason contract without exposing transport metadata. */
export async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload: unknown = await response.json().catch(() => null);
  if (isApiFailure(payload)) return new ApiError(response.status, payload);
  return new Error(errorMessage(payload, fallback));
}
