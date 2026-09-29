import type { ApiFailureBody } from './http';

/** 统一成功响应载荷（与 PLAN 约定的 ApiSuccess 一致） */
export interface ApiSuccessBody<T> {
  data: T;
  requestId: string;
}

/**
 * 构造统一成功响应载荷；handler 中用 `c.json(apiData(c, data), status)` 返回，
 * 以保留 Hono TypedResponse 推断与 OpenAPI schema 的一致性。
 */
export function apiData<T>(c: { get(key: 'requestId'): string }, data: T): ApiSuccessBody<T> {
  return { data, requestId: c.get('requestId') };
}

export type { ApiFailureBody };

export type JsonSuccess = { data: unknown; requestId: string };
