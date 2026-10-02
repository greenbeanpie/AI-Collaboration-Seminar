import { act,fireEvent,render,screen,waitFor,cleanup } from '@testing-library/react';
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

const testNotice={id:'831cab18-6eec-4738-a7bb-52f246e3b492',kind:'push_test',title:'通知推送测试',body:'单次测试摘要',url:'/app/settings/notifications',createdAt:'2026-10-01T12:28:24.136Z',readAt:null,dismissedAt:null};
it('updates an already-open history page from the normal live inbox snapshot without sending anything',async()=>{
 setup();await waitFor(()=>expect(screen.getByRole('checkbox',{name:/网页顶部提醒/})).toBeEnabled());expect(screen.getByText('暂无通知。')).toBeInTheDocument();
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'account',items:[testNotice],nextCursor:null,unreadCount:1}})));
 expect(screen.getByText('通知推送测试')).toBeInTheDocument();expect(screen.queryByText('暂无通知。')).not.toBeInTheDocument();expect(request.mock.calls.filter(([,method])=>method&&method!=='GET')).toHaveLength(0);
});
it('ignores a different-account snapshot and does not let a late initial empty response erase newer history',async()=>{
 let finish:(value:unknown)=>void=()=>{};setup();
 const initial=request.mock.calls.length;
 // A fresh identity mounts with a deliberately delayed first history response.
 cleanup();request.mockImplementation(async <T,>(path:string)=>{
  if(path.includes('/push/status'))return {configured:false,publicKey:''} as T;
  if(path.includes('/settings'))return {inAppEnabled:true,pushEnabled:true} as T;
  return await new Promise<T>(resolve=>{finish=value=>resolve(value as T);});
 });
 render(<MemoryRouter><NotificationSettings userId="account"/></MemoryRouter>);expect(request.mock.calls.length).toBeGreaterThan(initial);
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'other',items:[testNotice],nextCursor:null,unreadCount:1}})));expect(screen.queryByText('通知推送测试')).not.toBeInTheDocument();
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'account',items:[testNotice],nextCursor:null,unreadCount:1}})));expect(screen.getByText('通知推送测试')).toBeInTheDocument();
 await act(async()=>{finish({items:[],nextCursor:null,unreadCount:0});await Promise.resolve();});expect(screen.getByText('通知推送测试')).toBeInTheDocument();
});
it('refreshes history on a same-route full-history request without needing a remount',async()=>{
 setup();await waitFor(()=>expect(screen.getByRole('checkbox',{name:/网页顶部提醒/})).toBeEnabled());
 request.mockImplementation(async <T,>(path:string)=>path.includes('/push/status')?{configured:false,publicKey:''} as T:path.includes('/settings')?{inAppEnabled:true,pushEnabled:true} as T:{items:[testNotice],nextCursor:null,unreadCount:1} as T);
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-refresh',{detail:{userId:'account'}})));expect(await screen.findByText('通知推送测试')).toBeInTheDocument();
});
it('discards stale cached older pages after a bulk-read refresh so reloading them uses server receipts',async()=>{
 setup();await waitFor(()=>expect(screen.getByRole('checkbox',{name:/网页顶部提醒/})).toBeEnabled());
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'account',items:[testNotice],nextCursor:'older',unreadCount:75}})));
 const older={...testNotice,id:'031cab18-6eec-4738-a7bb-52f246e3b492',title:'更早未读通知',createdAt:'2026-01-01T00:00:00.000Z'};
 request.mockImplementation(async<T,>(path:string)=>path.includes('/push/status')?{configured:false,publicKey:''} as T:path.includes('/settings')?{inAppEnabled:true,pushEnabled:true} as T:{items:[older],nextCursor:null,unreadCount:75} as T);
 fireEvent.click(screen.getByRole('button',{name:'加载更早通知'}));await screen.findByText('更早未读通知');
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'account',items:[{...testNotice,readAt:'2026-10-02T00:00:00.000Z'}],nextCursor:'older',unreadCount:0,resetHistory:true}})));
 expect(screen.queryByText('更早未读通知')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'加载更早通知'})).toBeEnabled();expect(screen.queryByRole('button',{name:'标记已读'})).not.toBeInTheDocument();
 request.mockImplementation(async<T,>()=>({items:[{...older,readAt:'2026-10-02T00:00:00.000Z'}],nextCursor:null,unreadCount:0}) as T);
 fireEvent.click(screen.getByRole('button',{name:'加载更早通知'}));await screen.findByText('更早未读通知');expect(screen.queryByRole('button',{name:'标记已读'})).not.toBeInTheDocument();
});
it('does not restore an older unread page that arrives after a bulk reset',async()=>{
 setup();await waitFor(()=>expect(screen.getByRole('checkbox',{name:/网页顶部提醒/})).toBeEnabled());
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'account',items:[testNotice],nextCursor:'older',unreadCount:75}})));
 let finish!:(page:unknown)=>void;
 request.mockImplementation(async<T,>()=>await new Promise<T>(resolve=>{finish=page=>resolve(page as T);}));
 fireEvent.click(screen.getByRole('button',{name:'加载更早通知'}));
 act(()=>window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{userId:'account',items:[{...testNotice,readAt:'2026-10-02T00:00:00.000Z'}],nextCursor:'older',unreadCount:0,resetHistory:true}})));
 await act(async()=>finish({items:[{...testNotice,id:'031cab18-6eec-4738-a7bb-52f246e3b492',title:'旧请求的未读通知'}],nextCursor:null,unreadCount:75}));
 expect(screen.queryByText('旧请求的未读通知')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'标记已读'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'加载更早通知'})).toBeEnabled();
});
