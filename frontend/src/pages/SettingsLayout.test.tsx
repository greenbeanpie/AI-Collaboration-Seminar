import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsLayout } from './SettingsLayout';
import { useSettingsDirty } from './settings-dirty';
import { useState } from 'react';
const state = vi.hoisted(() => ({ role: 'user', isAdmin: false }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'fixture', ...state } }) }));
function Editor() { const [value, setValue] = useState(''); useSettingsDirty(Boolean(value)); return <input aria-label="draft" value={value} onChange={e => setValue(e.target.value)} />; }
function setup(initialEntries = ['/app/settings/profile'], initialIndex?: number) {
 const router = createMemoryRouter([{ path: '/app/settings', element: <SettingsLayout />, children: [{ path: 'profile', element: <Editor /> }, { path: 'security', element: <p>Security form</p> }, { path: 'appearance', element: <p>Theme</p> }] }, { path: '*', element: <Outlet /> }], { initialEntries, initialIndex });
 render(<RouterProvider router={router} />); return router;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); state.role = 'user'; state.isAdmin = false; });
it('hides privileged tabs and preserves separate admin capabilities', () => {
 setup(); expect(screen.queryByRole('link', { name: '账户管理' })).toBeNull(); expect(screen.queryByRole('link', { name: 'AI 配置' })).toBeNull(); cleanup();
 state.isAdmin = true; state.role = 'admin'; setup(); expect(screen.getByRole('link', { name: '账户管理' })).toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'AI 配置' })).toBeNull(); cleanup();
 state.role = 'super_admin'; setup(); expect(screen.getByRole('link', { name: 'AI 配置' })).toBeInTheDocument();
});
it('canceling tab navigation preserves unsaved editing; confirming navigates', async () => {
 const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); const router = setup(); fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved' } });
 fireEvent.click(screen.getByRole('link', { name: '账户安全' })); expect(confirm).toHaveBeenCalledTimes(1); expect(screen.getByLabelText('draft')).toHaveValue('unsaved'); expect(router.state.location.pathname).toBe('/app/settings/profile');
 confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('link', { name: '账户安全' })); expect(await screen.findByText('Security form')).toBeInTheDocument();
});
it('Back cancellation preserves deep link and draft, then Back/Forward work', async () => {
 const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); const router = setup(['/app/settings/security', '/app/settings/profile'], 1);
 fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'draft' } }); await act(() => router.navigate(-1)); expect(screen.getByLabelText('draft')).toHaveValue('draft');
 confirm.mockReturnValue(true); await act(() => router.navigate(-1)); expect(screen.getByText('Security form')).toBeInTheDocument(); await act(() => router.navigate(1)); expect(screen.getByLabelText('draft')).toHaveValue('');
});
it('same URL navigation does not prompt or discard drafts', async () => {
 const confirm = vi.spyOn(window, 'confirm'); const router = setup(); fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'draft' } }); await act(() => router.navigate('/app/settings/profile')); expect(confirm).not.toHaveBeenCalled(); expect(screen.getByLabelText('draft')).toHaveValue('draft');
});
it('warns before unloading unsaved settings unless the shared update confirmation was accepted', () => {
 setup(); fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'draft' } });
 const before = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(before); expect(before.defaultPrevented).toBe(true);
 window.dispatchEvent(new Event('app-update-reload'));
 const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
});
it('canceling logout preserves edits and vetoes logout before account API writes', () => {
 const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); setup(); fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'draft' } });
 const leave = new Event('settings-before-leave', { cancelable: true }); expect(window.dispatchEvent(leave)).toBe(false); expect(confirm).toHaveBeenCalledOnce(); expect(screen.getByLabelText('draft')).toHaveValue('draft');
});
it('failed logout restores the unsaved edit guard', () => {
 const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true); setup(); fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'draft' } });
 act(() => { expect(window.dispatchEvent(new Event('settings-before-leave', { cancelable: true }))).toBe(true); window.dispatchEvent(new Event('settings-leave-failed')); });
 confirm.mockReturnValue(false); fireEvent.click(screen.getByRole('link', { name: '账户安全' })); expect(screen.getByLabelText('draft')).toHaveValue('draft'); expect(confirm).toHaveBeenCalledTimes(2);
});
