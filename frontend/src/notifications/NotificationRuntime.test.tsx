import { act,cleanup,render,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { NotificationRuntime } from './NotificationRuntime';
import { notificationRequest } from './api';
import type { NotificationPage } from './core';
vi.mock('./api',()=>({notificationRequest:vi.fn()}));
const request=vi.mocked(notificationRequest),listeners:Array<[string,EventListener]>=[];
const notice={id:'831cab18-6eec-4738-a7bb-52f246e3b492',kind:'source_added',title:'项目更新',body:'摘要',url:'/app',createdAt:'2026-10-02T00:00:00.000Z',readAt:null,dismissedAt:null};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
function watch(type:string){const callback=vi.fn();window.addEventListener(type,callback);listeners.push([type,callback]);return callback;}
function signal(userId='account'){window.dispatchEvent(new CustomEvent('app-notification-read-all',{detail:{userId}}));}
function settings(path:string){return path.includes('/push/status')?{configured:false,publicKey:''}:{inAppEnabled:true,pushEnabled:false};}
beforeEach(()=>{vi.clearAllMocks();Object.defineProperty(navigator,'onLine',{configurable:true,value:true});Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:Object.assign(new EventTarget(),{getRegistration:async()=>undefined})});});
afterEach(()=>{cleanup();for(const [type,callback]of listeners)window.removeEventListener(type,callback);listeners.length=0;vi.unstubAllGlobals();});
function show(account='account'){return render(<MemoryRouter><NotificationRuntime userId={account} settingsUrl="/app/settings/notifications" /></MemoryRouter>);}
it('waits for persistence before refreshing the badge/list and locks duplicate requests to the starting account',async()=>{
 const mutation=deferred<{updatedCount:number;unreadCount:number}>(),inbox=watch('app-notification-inbox'),status=watch('app-notification-read-all-status');let saved=false;
 request.mockImplementation(async<T,>(path:string)=>{
  if(path==='/notifications/read-all'){await mutation.promise;saved=true;return {updatedCount:75,unreadCount:0} as T;}
  return (path.includes('?limit=50')?{items:[{...notice,readAt:saved?'2026-10-02T01:00:00.000Z':null}],unreadCount:saved?0:75,nextCursor:'more'}:settings(path)) as T;
 });
 show();await waitFor(()=>expect(inbox).toHaveBeenCalledOnce());
 act(()=>{signal();signal();});expect(request.mock.calls.filter(([path])=>path==='/notifications/read-all')).toHaveLength(1);expect(inbox.mock.calls.at(-1)![0].detail.unreadCount).toBe(75);expect(status.mock.calls.at(-1)![0].detail.busy).toBe(true);
 expect(request).toHaveBeenCalledWith('/notifications/read-all','POST',{},expect.any(AbortSignal),'account');
 await act(async()=>mutation.resolve({updatedCount:75,unreadCount:0}));
 await waitFor(()=>expect(status.mock.calls.at(-1)![0].detail.busy).toBe(false));
 expect(inbox.mock.calls.at(-1)![0].detail).toMatchObject({userId:'account',unreadCount:0,resetHistory:true});expect(inbox.mock.calls.at(-1)![0].detail.items[0].readAt).toBeTruthy();
});
it('does not clear the count on a failed mutation or a failed refresh',async()=>{
 const inbox=watch('app-notification-inbox'),status=watch('app-notification-read-all-status');let mode='initial';
 request.mockImplementation(async<T,>(path:string)=>{
  if(path==='/notifications/read-all'){if(mode==='fail')throw new Error('网络未连接');mode='refresh-fail';return {updatedCount:75,unreadCount:0} as T;}
  if(path.includes('?limit=50')){if(mode==='refresh-fail')throw new Error('无法刷新');return {items:[notice],unreadCount:75,nextCursor:'more'} as T;}return settings(path) as T;
 });
 show();await waitFor(()=>expect(inbox).toHaveBeenCalledOnce());mode='fail';act(()=>signal());await waitFor(()=>expect(status.mock.calls.at(-1)![0].detail.message).toBe('网络未连接'));expect(inbox.mock.calls.at(-1)![0].detail.unreadCount).toBe(75);
 mode='save';act(()=>signal());await waitFor(()=>expect(status.mock.calls.at(-1)![0].detail.message).toContain('列表刷新失败'));expect(inbox).toHaveBeenCalledOnce();
});
it('ignores an older poll after the forced post-mutation refresh',async()=>{
 const older=deferred<NotificationPage>(),inbox=watch('app-notification-inbox'),status=watch('app-notification-read-all-status');let reads=0;
 request.mockImplementation(async<T,>(path:string)=>{
  if(path==='/notifications/read-all')return {updatedCount:75,unreadCount:0} as T;
  if(path.includes('?limit=50')){if(++reads===1)return await older.promise as T;return {items:[{...notice,readAt:'2026-10-02T01:00:00Z'}],unreadCount:2,nextCursor:null} as T;}return settings(path) as T;
 });
 show();act(()=>signal());await waitFor(()=>expect(status.mock.calls.at(-1)![0].detail.busy).toBe(false));expect(inbox.mock.calls.at(-1)![0].detail.unreadCount).toBe(2);
 await act(async()=>older.resolve({items:[notice],unreadCount:75,nextCursor:'more'}));expect(inbox).toHaveBeenCalledOnce();expect(inbox.mock.calls.at(-1)![0].detail.unreadCount).toBe(2);
});
it.each(['resolve','reject'] as const)('cannot publish late %s results after switching accounts',async(outcome)=>{
 const mutation=deferred<{updatedCount:number;unreadCount:number}>(),inbox=watch('app-notification-inbox'),status=watch('app-notification-read-all-status');
 request.mockImplementation(async<T,>(path:string)=>path==='/notifications/read-all'?await mutation.promise as T:path.includes('?limit=50')?{items:[notice],unreadCount:5,nextCursor:null} as T:settings(path) as T);
 const view=show('previous');await waitFor(()=>expect(inbox.mock.calls.at(-1)![0].detail.userId).toBe('previous'));act(()=>signal('previous'));
 view.rerender(<MemoryRouter><NotificationRuntime userId="current" settingsUrl="/app/settings/notifications" /></MemoryRouter>);
 await waitFor(()=>expect(inbox.mock.calls.at(-1)![0].detail.userId).toBe('current'));const statuses=status.mock.calls.length,snapshots=inbox.mock.calls.length;
 await act(async()=>{if(outcome==='resolve')mutation.resolve({updatedCount:5,unreadCount:0});else mutation.reject(new Error('old account failure'));});
 expect(status.mock.calls).toHaveLength(statuses);expect(inbox.mock.calls).toHaveLength(snapshots);
 expect(request.mock.calls.find(([path])=>path==='/notifications/read-all')?.[4]).toBe('previous');
});
