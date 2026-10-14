import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PasswordResetPage } from './PasswordResetPage';
import { PublicHelpPage } from './PublicHelpPage';
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
it('redeems a fragment-only code once, removes it from the URL and returns to login after revoking sessions', async () => {
  window.history.replaceState({}, '', '/password-reset#token=' + 'a'.repeat(43));
  const fetcher = vi.fn(async () => Response.json({ data: { revoked: true } })); vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/password-reset']}><Routes><Route path="/password-reset" element={<PasswordResetPage />} /><Route path="/login" element={<h1>重新登录</h1>} /></Routes></MemoryRouter></QueryClientProvider>);
  expect(window.location.hash).toBe('');
  fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'replacement-password-123' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'replacement-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '恢复密码并退出旧设备' }));
  await screen.findByText('重新登录');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
it('public help supplies the authorized contact without an authenticated request or automatic email', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  render(<MemoryRouter><PublicHelpPage /></MemoryRouter>);
  expect(screen.getByRole('link', { name: '2945531970@qq.com' })).toHaveAttribute('href', 'mailto:2945531970@qq.com');
  expect(fetcher).not.toHaveBeenCalled();
});
