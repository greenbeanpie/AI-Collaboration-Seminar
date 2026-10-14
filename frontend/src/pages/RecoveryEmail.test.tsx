import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PasswordForgotPage } from './PasswordForgotPage';
import { RecoveryEmailSettings } from './RecoveryEmailSettings';
import { EmailVerifyPage } from './EmailVerifyPage';
import { PublicHelpPage } from './PublicHelpPage';

const mocks=vi.hoisted(()=>({request:vi.fn(),user:{id:'first',username:'first-user',displayName:'First'},capabilities:{authentication:{turnstileRequired:false,turnstileSiteKey:null}}}));
vi.mock('../auth',()=>({useSession:()=>({data:mocks.user}),useCapabilities:()=>({data:mocks.capabilities,refetch:vi.fn()})}));
vi.mock('../api/simplification',()=>({accountRequest:mocks.request}));
const clients:QueryClient[]=[];
function setup(node:React.ReactNode){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});clients.push(client);const view=(content:React.ReactNode)=><QueryClientProvider client={client}><MemoryRouter>{content}</MemoryRouter></QueryClientProvider>;return {...render(view(node)),view};}
beforeEach(()=>{mocks.request.mockReset();mocks.user={id:'first',username:'first-user',displayName:'First'};localStorage.clear();sessionStorage.clear();});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());window.history.replaceState({},'','/');vi.unstubAllGlobals();});

it('makes email recovery the main public help entry and retains the authorized fallback',()=>{
 setup(<PublicHelpPage/>);expect(screen.getByRole('link',{name:'通过邮件恢复密码'})).toHaveAttribute('href','/password-forgot');expect(screen.getByRole('link',{name:'2945531970@qq.com'})).toHaveAttribute('href','mailto:2945531970@qq.com');expect(mocks.request).not.toHaveBeenCalled();
});
it('submits the anonymous form by keyboard, shows generic accepted and does not persist identity',async()=>{
 mocks.request.mockResolvedValue({accepted:true});setup(<PasswordForgotPage/>);
 fireEvent.change(screen.getByLabelText('用户名或已验证邮箱'),{target:{value:'first-user'}});fireEvent.submit(screen.getByRole('button',{name:'申请恢复邮件'}).closest('form')!);
 await screen.findByText(/申请已受理。若账户已绑定并验证恢复邮箱/);
 expect(mocks.request).toHaveBeenCalledWith('/api/v1/auth/password-recovery/request',expect.objectContaining({method:'POST',networkOnly:true,timeoutMs:30000,body:{account:'first-user'}}));expect(localStorage.length).toBe(0);expect(sessionStorage.length).toBe(0);
});
it('cancelled sends unlock the form, explain unknown outcome and never replay automatically',async()=>{
 mocks.request.mockImplementation((_path,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason))));setup(<PasswordForgotPage/>);
 fireEvent.change(screen.getByLabelText('用户名或已验证邮箱'),{target:{value:'first-user'}});fireEvent.click(screen.getByRole('button',{name:'申请恢复邮件'}));
 fireEvent.click(await screen.findByRole('button',{name:'取消等待'}));await screen.findByText(/请求结果尚未确认。邮件可能已发送/);expect(screen.getByRole('button',{name:'申请恢复邮件'})).toBeEnabled();expect(mocks.request).toHaveBeenCalledOnce();
});
it('clears current password after verification request and separates verified from registration email',async()=>{
 mocks.request.mockImplementation((_path,options)=>options?.method?Promise.resolve({accepted:true}):Promise.resolve({email:'registration@example.com',verified:false}));setup(<RecoveryEmailSettings/>);
 await screen.findByText(/尚未验证，不能用于密码恢复/);
 fireEvent.change(screen.getByLabelText('待验证的恢复邮箱'),{target:{value:'new@example.com'}});fireEvent.change(screen.getByLabelText('当前密码（核实邮箱操作）'),{target:{value:'private-password'}});fireEvent.submit(screen.getByRole('button',{name:'发送验证邮件'}).closest('form')!);
 await screen.findByText(/验证申请已受理。请检查新邮箱/);expect(screen.getByLabelText('当前密码（核实邮箱操作）')).toHaveValue('');
 expect(localStorage.length).toBe(0);expect(sessionStorage.length).toBe(0);
 expect(mocks.request).toHaveBeenCalledWith('/api/v1/auth/recovery-email',expect.objectContaining({body:{email:'new@example.com',currentPassword:'private-password'}}));
});
it('account-keyed settings cancel an old send and do not display its success under a new account',async()=>{
 let finish:(value:unknown)=>void=()=>{};
 mocks.request.mockImplementation((_path,options)=>options?.method?new Promise(resolve=>{finish=resolve;}):Promise.resolve({email:'first@example.com',verified:true}));
 const rendered=setup(<RecoveryEmailSettings key="first"/>);await screen.findByText(/first@example.com/);
 fireEvent.change(screen.getByLabelText('待验证的恢复邮箱'),{target:{value:'new@example.com'}});fireEvent.change(screen.getByLabelText('当前密码（核实邮箱操作）'),{target:{value:'private-password'}});fireEvent.click(screen.getByRole('button',{name:'发送验证邮件'}));
 mocks.user={id:'second',username:'second-user',displayName:'Second'};mocks.request.mockResolvedValue({email:null,verified:false});rendered.rerender(rendered.view(<RecoveryEmailSettings key="second"/>));await screen.findByText(/未绑定/);
 await act(async()=>finish({accepted:true}));expect(screen.queryByText(/验证申请已受理/)).not.toBeInTheDocument();expect(screen.getByLabelText('待验证的恢复邮箱')).toHaveValue('');expect(screen.getByLabelText('当前密码（核实邮箱操作）')).toHaveValue('');
});
it('loads a fragment verification code only in memory, removes the fragment and consumes it for the current user',async()=>{
 window.history.replaceState({},'','/email-verify#token='+'a'.repeat(43));mocks.request.mockResolvedValue({verified:true});setup(<EmailVerifyPage/>);expect(window.location.hash).toBe('');expect(screen.getByLabelText('邮箱验证代码')).toHaveValue('a'.repeat(43));
 fireEvent.submit(screen.getByRole('button',{name:'确认验证恢复邮箱'}).closest('form')!);await screen.findByText('恢复邮箱已验证，今后可以通过邮件恢复密码。');expect(screen.getByLabelText('邮箱验证代码')).toHaveValue('');expect(localStorage.length).toBe(0);expect(sessionStorage.length).toBe(0);
 await waitFor(()=>expect(mocks.request).toHaveBeenCalledWith('/api/v1/auth/recovery-email/verify',expect.objectContaining({body:{token:'a'.repeat(43)},headers:{'X-Account-Settings':'1'}})));
});
it('clears a verification code when the signed-in account changes',async()=>{
 window.history.replaceState({},'','/email-verify#token='+'a'.repeat(43));const rendered=setup(<EmailVerifyPage/>);expect(screen.getByLabelText('邮箱验证代码')).toHaveValue('a'.repeat(43));
 mocks.user={id:'second',username:'second-user',displayName:'Second'};rendered.rerender(rendered.view(<EmailVerifyPage/>));await waitFor(()=>expect(screen.getByLabelText('邮箱验证代码')).toHaveValue(''));expect(mocks.request).not.toHaveBeenCalled();
});
it('re-enables recovery submission after the browser comes back online',async()=>{
 const offlineNavigator=Object.create(navigator);Object.defineProperty(offlineNavigator,'onLine',{value:false,configurable:true});vi.stubGlobal('navigator',offlineNavigator);setup(<PasswordForgotPage/>);expect(screen.getByRole('button',{name:'申请恢复邮件'})).toBeDisabled();
 Object.defineProperty(navigator,'onLine',{value:true,configurable:true});fireEvent(window,new Event('online'));await waitFor(()=>expect(screen.getByRole('button',{name:'申请恢复邮件'})).toBeEnabled());
});
