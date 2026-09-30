import type { ApiFailure, ApiEnvelope, DataOf, SchemaName } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(status: number, failure: ApiFailure) {
    super(failure.error.message || '请求失败');
    this.name = 'ApiError';
    this.status = status;
    this.code = failure.error.code;
    this.requestId = failure.requestId;
    this.retryable = failure.error.retryable;
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
};

function makeRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function apiUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.startsWith('/api') ? path : `/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export async function request<Name extends SchemaName>(path: string, options: RequestOptions = {}): Promise<DataOf<Name>> {
  const method = options.method ?? 'GET';
  const requestId = makeRequestId();
  const headers = new Headers(options.headers);
  headers.set('X-Request-Id', requestId);
  const hasJsonBody = options.body !== undefined;
  if (hasJsonBody) headers.set('Content-Type', 'application/json');
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

  let response: Response;
  try {
    response = await fetch(apiUrl(path, options.query), {
      method,
      credentials: 'include',
      headers,
      body: options.rawBody ?? (hasJsonBody ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, {
      error: { code: 'NETWORK_ERROR', message: '无法连接服务，请检查网络或后端是否启动。', retryable: true },
      requestId,
    });
  }

  const returnedRequestId = response.headers.get('X-Request-Id') ?? requestId;
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const failure = isApiFailure(payload)
      ? payload
      : {
          error: { code: `HTTP_${response.status}`, message: '服务暂时无法处理该请求。', retryable: response.status >= 500 },
          requestId: returnedRequestId,
        } satisfies ApiFailure;
    if (response.status === 401 && !path.endsWith('/auth/session')) window.dispatchEvent(new CustomEvent('auth-expired'));
    throw new ApiError(response.status, failure);
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError(response.status, {
      error: { code: 'INVALID_RESPONSE', message: '服务返回了无法识别的响应。', retryable: false },
      requestId: returnedRequestId,
    });
  }
  return (payload as ApiEnvelope<DataOf<Name>>).data;
}

export function isApiFailure(value: unknown): value is ApiFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ApiFailure>;
  return typeof candidate.requestId === 'string' && typeof candidate.error?.code === 'string' && typeof candidate.error.message === 'string';
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

export const projectPath = (projectId: string, tail = '') => `/api/v1/projects/${encodeURIComponent(projectId)}${tail}`;
