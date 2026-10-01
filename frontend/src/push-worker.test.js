import { afterEach,expect,it,vi } from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
async function setup() {
 const client={url:'https://app.example/edited-form',postMessage:vi.fn(),focus:vi.fn(async()=>{})};
 const sw=new EventTarget();sw.location={origin:'https://app.example',pathname:'/sw.js'};sw.registration={showNotification:vi.fn(async()=>{})};sw.clients={matchAll:vi.fn(async()=>[client]),openWindow:vi.fn(async()=>{})};
 vi.stubGlobal('self',sw);vi.stubGlobal('__PUSH_TEST__',true);await import('../public/push-worker.js');return {sw,client,...globalThis.__pushFunctions};
}
it('requires current-account ownership and minimizes lock-screen summaries',async()=>{
 const t=await setup();const payload={title:'PRIVATE PROJECT',body:'PRIVATE TICKET',data:{userId:'owner',notificationId:'fixture',url:'/app/support/fixture'}};
 await t.receivePush({data:{json:()=>payload}},async()=>null);await t.receivePush({data:{json:()=>payload}},async()=>'another');expect(t.sw.registration.showNotification).not.toHaveBeenCalled();
 await t.receivePush({data:{json:()=>payload}},async()=>'owner');const [title,options]=t.sw.registration.showNotification.mock.calls[0];expect(title+options.body).not.toMatch(/PRIVATE/);expect(options.data.userId).toBe('owner');expect(t.client.postMessage).toHaveBeenCalledWith({type:'APP_PUSH_RECEIVED',userId:'owner',notificationId:'fixture'});
});
it('keeps notification clicks same-origin and lets an open edited page handle its own navigation',async()=>{
 const t=await setup();const notice={close:vi.fn(),data:{userId:'owner',notificationId:'fixture',url:'https://evil.example'}};
 await t.clickPush({notification:notice},async()=>'owner');expect(notice.close).toHaveBeenCalledOnce();expect(t.client.focus).toHaveBeenCalledOnce();expect(t.client.postMessage.mock.calls[0][0].url).not.toContain('evil');expect(t.sw.clients.openWindow).not.toHaveBeenCalled();
 for(const value of ['//evil.example','/\\evil.example','/api/v1/session','/x\nprivate'])expect(t.pushPath(value)).not.toBe(value);
 await t.clickPush({notification:notice},async()=>null);expect(t.client.focus).toHaveBeenCalledOnce();
});
it('opens an owned path when no page is loaded without sending private body',async()=>{
 const t=await setup();t.sw.clients.matchAll.mockResolvedValue([]);await t.clickPush({notification:{close:()=>{},data:{userId:'owner',notificationId:'fixture',url:'/app/support/fixture'}}},async()=>'owner');expect(t.sw.clients.openWindow).toHaveBeenCalledWith('/app/support/fixture');
});
