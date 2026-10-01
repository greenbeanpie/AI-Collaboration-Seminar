import { afterEach,expect,it,vi } from 'vitest';
import { NotificationFeed,notificationPermission,safeNotificationUrl,subscribeDevice,unsubscribeDevice,subscriptionPayload,type NotificationItem,type NotificationRequest } from './core';
afterEach(()=>vi.unstubAllGlobals());
const item=(id:string,extra:Partial<NotificationItem>={}):NotificationItem=>({id,kind:'ticket_reply',title:'更新',body:'查看应用',url:'/app/support/fixture',createdAt:new Date().toISOString(),readAt:null,dismissedAt:null,...extra});
it('hydrates history silently, deduplicates later polling and excludes read/dismissed entries from toasts',()=>{
 const feed=new NotificationFeed();expect(feed.accept([item('old')])).toEqual([]);expect(feed.accept([item('new'),item('old')]).map(value=>value.id)).toEqual(['new']);expect(feed.accept([item('new'),item('old')])).toEqual([]);expect(feed.accept([item('read',{readAt:'now'}),item('dismiss',{dismissedAt:'now'})])).toEqual([]);expect(new NotificationFeed().accept([item('new')])).toEqual([]);
});
it('restricts click URLs to owned paths, including encoded origins and control characters',()=>{
 for(const url of ['https://evil.example','//evil.example','/\\evil.example','/api/v1/session','javascript:alert(1)','/x\nhttps://evil.example'])expect(safeNotificationUrl(url,'/settings/notifications')).toBe('/settings/notifications');
 expect(safeNotificationUrl('/app/projects/id/requirements','/settings')).toBe('/app/projects/id/requirements');
});
it('does not request browser permission from capability detection and respects unsupported/denied',()=>{
 const requestPermission=vi.fn();vi.stubGlobal('window',{isSecureContext:true,Notification:{permission:'denied',requestPermission},PushManager:{}});vi.stubGlobal('navigator',{serviceWorker:{}});vi.stubGlobal('Notification',{permission:'denied',requestPermission});expect(notificationPermission()).toBe('denied');expect(requestPermission).not.toHaveBeenCalled();vi.stubGlobal('window',{isSecureContext:false});expect(notificationPermission()).toBe('unsupported');
});
function browser() {
 const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)});
 class Channel {port1:{onmessage:((event:{data:{ok:boolean}})=>void)|null;close:()=>void}={onmessage:null,close:()=>{}};port2={postMessage:(value:{ok:boolean})=>queueMicrotask(()=>this.port1.onmessage?.({data:value}))};}
 vi.stubGlobal('MessageChannel',Channel);vi.stubGlobal('window',{isSecureContext:true,Notification:{permission:'granted'},PushManager:{},setTimeout,clearTimeout});vi.stubGlobal('Notification',{permission:'granted'});
 const subscription={endpoint:'https://fcm.googleapis.com/send/fixture',toJSON:()=>({endpoint:'https://fcm.googleapis.com/send/fixture',expirationTime:null,keys:{p256dh:'public-fixture',auth:'auth-fixture'}}),unsubscribe:vi.fn(async()=>true)} as unknown as PushSubscription;
 const manager={getSubscription:vi.fn(async()=>subscription),subscribe:vi.fn(async()=>subscription)};
 const registration={active:{postMessage:vi.fn((_message:unknown,ports:{postMessage:(value:{ok:boolean})=>void}[])=>ports[0]!.postMessage({ok:true}))},pushManager:manager,getNotifications:vi.fn(async()=>[])};
 vi.stubGlobal('navigator',{serviceWorker:{getRegistration:vi.fn(async()=>registration)}});
 return {subscription,manager,stored,registration};
}
it('sends only endpoint and keys, keeps an owned device and replaces a different-account subscription',async()=>{
 const t=browser();const calls:{path:string;body:unknown}[]=[];
 const request:NotificationRequest=async <T,>(path:string,_method?:string,body?:unknown)=>{calls.push({path,body});return (path.endsWith('lookup')?{id:'owned'}:{id:'saved'}) as T;};
 await subscribeDevice('account','BA',request);expect(t.manager.subscribe).not.toHaveBeenCalled();expect(calls.at(-1)?.body).toEqual({endpoint:t.subscription.endpoint,keys:{p256dh:'public-fixture',auth:'auth-fixture'}});expect(t.stored.get('app-push-device:account')).toBe('saved');
 const other:NotificationRequest=async <T,>(path:string)=> (path.endsWith('lookup')?{id:null}:{id:'fresh'}) as T;
 await subscribeDevice('new-account','BA',other);expect(t.subscription.unsubscribe).toHaveBeenCalledOnce();expect(t.manager.subscribe).toHaveBeenCalledOnce();
 expect(Object.keys(subscriptionPayload(t.subscription))).toEqual(['endpoint','keys']);
});
it('retains login/device state on server revoke failure and cancels only after confirmed revoke',async()=>{
 const t=browser();t.stored.set('app-push-device:account','owned');
 const failed:NotificationRequest=async()=>{throw new Error('offline');};await expect(unsubscribeDevice('account',failed)).rejects.toThrow('offline');expect(t.subscription.unsubscribe).not.toHaveBeenCalled();expect(t.stored.get('app-push-device:account')).toBe('owned');
 const request:NotificationRequest=async <T,>()=>({id:'owned'}) as T;await unsubscribeDevice('account',request);expect(t.subscription.unsubscribe).toHaveBeenCalledOnce();expect(t.stored.has('app-push-device:account')).toBe(false);expect(t.registration.active.postMessage).toHaveBeenLastCalledWith({type:'PUSH_ACCOUNT',userId:null},expect.any(Array));
});
