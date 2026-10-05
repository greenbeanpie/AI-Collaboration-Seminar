import { afterEach, expect, it, vi } from 'vitest';
import { request } from './client';
afterEach(() => vi.unstubAllGlobals());
it.each([
  () => Response.json({ message: '来源不存在或权限已变化\n请重新选择原文件' }, { status: 409 }),
  () => new Response('来源不存在或权限已变化\n请重新选择原文件', { status: 409, headers: { 'Content-Type': 'text/plain' } }),
  () => Response.json({ error: { message: '来源不存在或权限已变化\n请重新选择原文件' } }, { status: 409 }),
])('passes backend reasons without depending on an error code or request ID', async response => {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  await expect(request<'ProjectResponse'>('/reason-probe', { networkOnly: true })).rejects.toThrow('来源不存在或权限已变化\n请重新选择原文件');
});
