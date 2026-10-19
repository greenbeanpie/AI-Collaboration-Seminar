import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NativeAuthorizePage } from './NativeAuthorizePage';

const session = vi.hoisted(() => ({ data: { id: 'user-1', username: 'native_user', displayName: '用户' } as { id: string; username: string; displayName: string } | null, isPending: false, error: null }));
vi.mock('../auth', () => ({ useSession: () => session }));
const id = '12345678-1234-4234-8234-123456789abc'; const state = 's'.repeat(43);
const clients: QueryClient[] = [];
function setup(transaction = id) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/native-authorize?transaction=${transaction}`]}><NativeAuthorizePage /></MemoryRouter></QueryClientProvider>);
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); session.data = { id: 'user-1', username: 'native_user', displayName: '用户' }; });
const response = (data: unknown) => Response.json({ data, requestId: 'native-test' });

describe('Native browser authorization page', () => {
  it('preserves the app authorization route through browser login', () => {
    session.data = null; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); setup();
    expect(screen.getByRole('link', { name: '先登录浏览器账户' })).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(`/app/native-authorize?transaction=${id}`)}`);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation then offers the fixed native callback', async () => {
    const callback = `buwei-native-preview://auth/callback?code=${'c'.repeat(43)}&state=${state}`;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST' ? response({ redirectUri: callback }) : response({ state, expiresAt: '2026-12-01T00:00:00Z' }));
    vi.stubGlobal('fetch', fetch); setup();
    const approve = await screen.findByRole('button', { name: '确认登录此账户' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(screen.getByText('native_user')).toBeInTheDocument();
    fireEvent.click(approve);
    expect(await screen.findByRole('link', { name: '返回补位原生预览' })).toHaveAttribute('href', callback);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('cancels without approving and preserves state in the denial callback', async () => {
    const fetch = vi.fn(async () => response({ state, expiresAt: '2026-12-01T00:00:00Z' })); vi.stubGlobal('fetch', fetch); setup();
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(screen.getByRole('status')).toHaveTextContent('已取消登录');
    expect(screen.getByRole('link', { name: '返回应用' })).toHaveAttribute('href', `buwei-native-preview://auth/callback?error=access_denied&state=${state}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports malformed and expired requests without offering approval', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const view = setup('bad');
    expect(screen.getByRole('alert')).toHaveTextContent('登录请求格式无效'); expect(fetch).not.toHaveBeenCalled(); view.unmount();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: '请求已过期' } }, { status: 400 }))); setup();
    expect(await screen.findByText('请求已过期')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认登录此账户' })).not.toBeInTheDocument();
  });
  it('rejects callbacks to another scheme or another client state', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST' ? response({ redirectUri: 'https://evil.invalid/?code=secret' }) : response({ state, expiresAt: '2026-12-01T00:00:00Z' }));
    vi.stubGlobal('fetch', fetch); setup(); fireEvent.click(await screen.findByRole('button', { name: '确认登录此账户' }));
    expect(await screen.findByText('应用回调地址不匹配，请重新登录。')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '返回补位原生预览' })).not.toBeInTheDocument();
  });
});
