import { fireEvent,render,screen,waitFor,cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
import { NotificationSettings } from './NotificationSettings';
import { notificationRequest } from './api';
vi.mock('./api',()=>({notificationRequest:vi.fn()}));
const request=vi.mocked(notificationRequest);
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(permission:'default'|'denied'|'granted'='default',configured=true) {
 const allow=vi.fn(async()=> { Object.defineProperty(Notification,'permission',{value:'granted',configurable:true}); return 'granted' as const; });vi.stubGlobal('Notification',{permission,requestPermission:allow});Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});Object.defineProperty(window,'PushManager',{value:{},configurable:true});Object.defineProperty(window,'Notification',{value:globalThis.Notification,configurable:true});
 class Channel {port1:{onmessage:((event:{data:{ok:boolean}})=>void)|null;close:()=>void}={onmessage:null,close:()=>{}};port2={postMessage:(value:{ok:boolean})=>queueMicrotask(()=>this.port1.onmessage?.({data:value}))};}vi.stubGlobal('MessageChannel',Channel);
 const subscription={endpoint:'https://fcm.googleapis.com/send/fixture',toJSON:()=>({endpoint:'https://fcm.googleapis.com/send/fixture',expirationTime:null,keys:{p256dh:'fixture-public',auth:'fixture-auth'}}),unsubscribe:vi.fn(async()=>true)};
 const subscribe=vi.fn(async()=>subscription);const worker={postMessage:vi.fn((_data,ports)=>ports[0].postMessage({ok:true}))};Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:vi.fn(async()=>({active:worker,pushManager:{getSubscription:async()=>null,subscribe},getNotifications:async()=>[]}))}});
 request.mockImplementation(async <T,>(path:string,method?:string,body?:unknown)=>{
  if(path.includes('/push/status'))return {configured,publicKey:'BA'} as T;
  if(path.includes('/push/subscriptions'))return {id:'subscription'} as T;
  if(path.includes('/settings'))return {inAppEnabled:true,pushEnabled:true,...(method==='PUT'?body as object:{})} as T;
  return {items:[],nextCursor:null,unreadCount:0} as T;
 });
 render(<MemoryRouter><NotificationSettings userId="account"/></MemoryRouter>);return {allow,subscribe};
}
it('shows missing backend push configuration without requesting permission',async()=>{
 const t=setup('default',false);await screen.findByText(/后台推送尚未配置/);expect(screen.getByRole('button',{name:'允许并订阅当前设备'})).toBeDisabled();expect(t.allow).not.toHaveBeenCalled();expect(screen.getByRole('checkbox',{name:/网页顶部提醒/})).toBeChecked();
});
it('respects denied permission and explains settings recovery without reprompting',async()=>{
 const t=setup('denied');await screen.findByText(/已尊重你的拒绝/);expect(screen.getByRole('button',{name:'允许并订阅当前设备'})).toBeDisabled();expect(t.allow).not.toHaveBeenCalled();
});
it('requests permission only from a click and prevents duplicate subscription submission',async()=>{
 const t=setup();const button=screen.getByRole('button',{name:'允许并订阅当前设备'});await waitFor(()=>expect(button).toBeEnabled());expect(t.allow).not.toHaveBeenCalled();fireEvent.click(button);fireEvent.click(button);await screen.findByText('当前设备已订阅系统通知。');expect(t.allow).toHaveBeenCalledOnce();expect(t.subscribe).toHaveBeenCalledOnce();
 expect(request).toHaveBeenCalledWith('/notifications/push/subscriptions','POST',{endpoint:'https://fcm.googleapis.com/send/fixture',keys:{p256dh:'fixture-public',auth:'fixture-auth'}},undefined,'account');
});
it('keeps the prior preference on failed save and passes the starting account guard',async()=>{
 setup();const toggle=screen.getByRole('checkbox',{name:/网页顶部提醒/});await waitFor(()=>expect(toggle).toBeEnabled());request.mockImplementationOnce(async()=>{throw new Error('offline');});fireEvent.click(toggle);await screen.findByText('offline');expect(toggle).toBeChecked();expect(request).toHaveBeenCalledWith('/notifications/settings','PUT',{inAppEnabled:false},undefined,'account');
});
