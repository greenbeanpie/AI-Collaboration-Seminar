import { cleanup, fireEvent, render, screen, act, within, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsLayout } from './SettingsLayout';
import { useSettingsDirty } from './settings-dirty';
import { useState } from 'react';
import { cancelPageDialog } from '../dialogs/dialog-service';
import { requestSettingsLeave } from '../dialogs/settings-leave';
const state = vi.hoisted(() => ({ role: 'user', isAdmin: false }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'fixture', ...state } }) }));
function Editor() { const [value, setValue] = useState(''); useSettingsDirty(Boolean(value)); return <input aria-label="draft" value={value} onChange={e => setValue(e.target.value)} />; }
function setup(initialEntries = ['/app/settings/profile'], initialIndex?: number) {
 const router = createMemoryRouter([{ path: '/app/settings', element: <SettingsLayout />, children: [{ path: 'profile', element: <Editor /> }, { path: 'security', element: <p>Security form</p> }, { path: 'appearance', element: <p>Theme</p> }] }, { path: '*', element: <Outlet /> }], { initialEntries, initialIndex });
 render(<RouterProvider router={router} />); return router;
}
async function answer(name:'确定'|'取消') { const dialog=await screen.findByRole('dialog'); await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name}));}); await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull()); }
afterEach(async () => { await act(async()=>{cancelPageDialog();}); cleanup(); vi.restoreAllMocks(); state.role = 'user'; state.isAdmin = false; });
it('hides privileged tabs and preserves separate admin capabilities', () => {
 setup(); expect(screen.queryByRole('link', { name: '账户管理' })).toBeNull(); expect(screen.queryByRole('link', { name: 'AI 配置' })).toBeNull(); cleanup();
 state.isAdmin = true; state.role = 'admin'; setup(); expect(screen.getByRole('link', { name: '账户管理' })).toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'AI 配置' })).toBeNull(); cleanup();
 state.role = 'super_admin'; setup(); expect(screen.getByRole('link', { name: 'AI 配置' })).toBeInTheDocument();
});
it('canceling tab navigation preserves unsaved editing; confirming navigates', async () => {
 const router=setup();fireEvent.change(screen.getByLabelText('draft'),{target:{value:'unsaved'}});
 fireEvent.click(screen.getByRole('link',{name:'账户安全'}));await answer('取消');expect(screen.getByLabelText('draft')).toHaveValue('unsaved');expect(router.state.location.pathname).toBe('/app/settings/profile');
 fireEvent.click(screen.getByRole('link',{name:'账户安全'}));await answer('确定');expect(await screen.findByText('Security form')).toBeInTheDocument();
});
it('Back cancellation preserves deep link and draft, then Back/Forward work', async()=>{
 const router=setup(['/app/settings/security','/app/settings/profile'],1);fireEvent.change(screen.getByLabelText('draft'),{target:{value:'draft'}});
 await act(()=>router.navigate(-1));await answer('取消');expect(screen.getByLabelText('draft')).toHaveValue('draft');expect(router.state.location.pathname).toBe('/app/settings/profile');
 await act(()=>router.navigate(-1));await answer('确定');expect(screen.getByText('Security form')).toBeInTheDocument();await act(()=>router.navigate(1));expect(screen.getByLabelText('draft')).toHaveValue('');
});
it('same URL navigation does not prompt or discard drafts', async()=>{
 const router=setup();fireEvent.change(screen.getByLabelText('draft'),{target:{value:'draft'}});await act(()=>router.navigate('/app/settings/profile'));expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByLabelText('draft')).toHaveValue('draft');
});
it('retains native close-page protection unless the in-page update decision was accepted',()=>{
 setup();fireEvent.change(screen.getByLabelText('draft'),{target:{value:'draft'}});const before=new Event('beforeunload',{cancelable:true});window.dispatchEvent(before);expect(before.defaultPrevented).toBe(true);window.dispatchEvent(new Event('app-update-reload'));const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);expect(after.defaultPrevented).toBe(false);
});
it('canceling logout preserves edits and waits before allowing account writes',async()=>{
 setup();fireEvent.change(screen.getByLabelText('draft'),{target:{value:'draft'}});let leave!:Promise<boolean>;let resolved=false;await act(async()=>{leave=requestSettingsLeave();});void leave.then(()=>{resolved=true;});expect(resolved).toBe(false);await answer('取消');expect(await leave).toBe(false);expect(screen.getByLabelText('draft')).toHaveValue('draft');
});
it('failed logout restores the unsaved edit guard',async()=>{
 setup();fireEvent.change(screen.getByLabelText('draft'),{target:{value:'draft'}});let leave!:Promise<boolean>;await act(async()=>{leave=requestSettingsLeave();});await answer('确定');expect(await leave).toBe(true);act(()=>{window.dispatchEvent(new Event('settings-leave-failed'));});fireEvent.click(screen.getByRole('link',{name:'账户安全'}));await answer('取消');expect(screen.getByLabelText('draft')).toHaveValue('draft');
});
