import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,expect,it,vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { SentUsernameInvitations } from './UsernameInvitations';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each([
  {code:'VALIDATION_FAILED',status:400,message:'无法向用户名「unknown-user」发送邀请，请核对完整登录用户名',title:'无法向用户名「unknown-user」发送邀请，请核对完整登录用户名'},
  {code:'INVALID_STATE',status:409,message:'对方已经是项目成员',title:'对方已经是项目成员'},
  {code:'INVALID_STATE',status:409,message:'项目人数已满、权限已变化或对方已经加入',title:'项目人数已满、权限已变化或对方已经加入'},
])('shows one invitation error title and keeps diagnostics separate: $code / $message',async({code,status,message,title})=>{
  const requestId='328b10e3-f7fd-4e08-9a9e-218a12384041';
  vi.stubGlobal('crypto',webcrypto);
  const sendBodies:unknown[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST') {
      sendBodies.push(JSON.parse(String(init.body)));
      return Response.json({requestId,error:{code,message,retryable:false,stage:'state',action:'refresh_state'}},{status});
    }
    return Response.json({requestId,data:{items:[],nextOffset:null}});
  }));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><SentUsernameInvitations projectId="test-project" /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText('完整用户名'),{target:{value:'  unknown-user  '}});
  fireEvent.click(screen.getByRole('button',{name:'发送项目邀请'}));
  const alert=await screen.findByRole('alert'),headline=alert.querySelector('strong')!;
  expect(headline.textContent).toBe(title);expect(headline.textContent).not.toContain(code);expect(headline.textContent).not.toContain(requestId);expect(headline.textContent).not.toContain('阶段');
  expect(alert.textContent).toBe(message); expect(alert.querySelector('details')).toBeNull();
  expect(screen.getByLabelText('完整用户名')).toHaveValue('  unknown-user  ');expect(screen.getByRole('button',{name:'发送项目邀请'})).toBeEnabled();
  expect(sendBodies).toEqual([{username:'unknown-user'}]);
});
