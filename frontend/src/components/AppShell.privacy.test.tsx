import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import * as store from '../offline/store';
import { AppShell } from './AppShell';
const user={id:'privacy-a',username:'alice',displayName:'Alice',email:null,isAdmin:false,role:'user' as const};
function setup(){const router=createMemoryRouter([{path:'*',element:<AppShell user={user}>workspace</AppShell>}],{initialEntries:['/app']});render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router}/></QueryClientProvider>);return router;}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
it('ordinary logout retains account drafts',async()=>{
 localStorage.setItem('buwei:draft:privacy-a:p:m','draft');vi.stubGlobal('navigator',{onLine:true});vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:{revoked:true}})));
 const router=setup();fireEvent.click(screen.getByRole('button',{name:'退出登录'}));await waitFor(()=>expect(router.state.location.pathname).toBe('/login'));expect(localStorage.getItem('buwei:draft:privacy-a:p:m')).toBe('draft');
});
it('confirms pending work before clearing only current-account data and flags offline session',async()=>{
 vi.spyOn(store,'operations').mockResolvedValue([{key:'pending'}] as never);const clear=vi.spyOn(store,'clearOfflineAccount').mockResolvedValue();vi.stubGlobal('navigator',{onLine:false});
 localStorage.setItem('buwei:draft:privacy-a:p:m','mine');localStorage.setItem('buwei:draft:privacy-b:p:m','other');localStorage.setItem('app-push-device:privacy-a','device');
 const router=setup();fireEvent.click(screen.getByRole('button',{name:'退出并清除此设备数据'}));await screen.findByRole('dialog');expect(screen.getByText(/尚有 1 项未同步/)).toBeInTheDocument();expect(clear).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'确认清除并退出'}));await waitFor(()=>expect(router.state.location.search).toBe('?localLogout=1'));
 expect(clear).toHaveBeenCalledWith('privacy-a');expect(localStorage.getItem('buwei:draft:privacy-a:p:m')).toBeNull();expect(localStorage.getItem('buwei:draft:privacy-b:p:m')).toBe('other');expect(localStorage.getItem('app-push-device:privacy-a')).toBeNull();
});
it('keeps cleanup failure visible and permits retry without claiming success',async()=>{
 vi.spyOn(store,'operations').mockResolvedValue([]);vi.spyOn(store,'clearOfflineAccount').mockRejectedValue(new Error('清除失败'));vi.stubGlobal('navigator',{onLine:false});const router=setup();
 fireEvent.click(screen.getByRole('button',{name:'退出并清除此设备数据'}));await screen.findByRole('dialog');fireEvent.click(screen.getByRole('button',{name:'确认清除并退出'}));await waitFor(()=>expect(screen.getAllByText('清除失败').length).toBeGreaterThan(0));expect(router.state.location.pathname).toBe('/app');
});
