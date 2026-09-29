import { z } from '@hono/zod-openapi';

/**
 * OpenAPI 响应信封：所有成功响应均为 { data, requestId }（与 PLAN 约定的 ApiSuccess 一致）。
 * name 用作 OpenAPI schema 的组件名。
 */
export function apiEnvelope<T extends z.ZodType>(data: T, name: string) {
  return z
    .object({
      data,
      requestId: z.string().openapi({ description: '请求关联 ID，与响应头 X-Request-Id 一致' }),
    })
    .openapi(name);
}
