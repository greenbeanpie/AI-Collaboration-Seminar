import { afterEach,expect,it,vi } from 'vitest';
let mounted;
afterEach(()=>{mounted?.remove();document.body.replaceChildren();vi.unstubAllGlobals();vi.resetModules();});
async function setup(waiting=false) {
 vi.stubGlobal('__UPDATES_TEST__',true);Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});
 const sw=new EventTarget();sw.controller={state:'activated'};const worker=new EventTarget();worker.state='installed';worker.postMessage=vi.fn();
 const registration=new EventTarget();Object.assign(registration,{active:sw.controller,waiting:waiting?worker:null,installing:null,update:vi.fn(async()=>{})});sw.register=vi.fn(async()=>registration);
 Object.defineProperty(navigator,'serviceWorker',{value:sw,configurable:true});
 document.body.innerHTML='<header aria-label="工作区顶栏"><span data-app-notification-controls></span><span>账户</span></header>';
 const {mountUpdates}=await import('../public/app-updates.js');mountUpdates();await Promise.resolve();await Promise.resolve();mounted=document.querySelector('app-updates');return {root:mounted.shadowRoot,worker};
}
it('mounts icon controls in the existing topbar with no additional page row and accessible status',async()=>{
 const t=await setup(true);expect(mounted.parentElement).toHaveAttribute('data-app-notification-controls');expect(mounted).toHaveClass('inline');expect(document.documentElement.style.getPropertyValue('--app-notification-height')).toBe('0px');
 const update=t.root.getElementById('update');expect(update.querySelector('svg')).not.toBeNull();expect(update).toHaveAttribute('title','下载完成 · 更新');expect(update).toHaveAttribute('aria-label','下载完成 · 更新');expect(update.dataset.state).toBe('ready');expect(t.root.getElementById('bell').querySelector('svg')).not.toBeNull();
 const confirm=vi.spyOn(window,'confirm');update.focus();update.click();const dialog=document.querySelector('[role="dialog"]');expect(dialog).not.toBeNull();expect(dialog.textContent).toContain('请先保存未提交的编辑、草稿和附件');expect(confirm).not.toHaveBeenCalled();expect(t.worker.postMessage).not.toHaveBeenCalled();Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent==='取消').click();await Promise.resolve();await Promise.resolve();expect(t.worker.postMessage).not.toHaveBeenCalled();expect(t.root.activeElement).toBe(update);
});
it('preserves unread badge, server read action and Back dismissal after inline mounting',async()=>{
 const t=await setup();window.dispatchEvent(new CustomEvent('app-notification-scope',{detail:'fixture-account'}));
 const item={id:'12345678-1234-1234-1234-123456789012',title:'工单有新回复',body:'请查看应用',url:'/app/support/fixture',createdAt:new Date().toISOString(),readAt:null,dismissedAt:null};
 window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{items:[item],unreadCount:17,url:'/app/settings/notifications'}}));
 const bell=t.root.getElementById('bell');expect(bell).toHaveAttribute('aria-label','通知中心，17 条未读');expect(t.root.getElementById('badge').textContent).toBe('17');bell.click();expect(t.root.getElementById('history').hidden).toBe(false);
 const state=vi.fn();window.addEventListener('app-notification-state',state);try {Array.from(t.root.querySelectorAll('button')).find(button=>button.textContent==='标记已读').click();expect(state.mock.calls[0][0].detail).toEqual({id:item.id,action:'read'});}finally{window.removeEventListener('app-notification-state',state);}
 window.dispatchEvent(new PopStateEvent('popstate'));expect(t.root.getElementById('history').hidden).toBe(true);expect(bell).toHaveAttribute('aria-expanded','false');
 const slot=mounted.parentElement;window.dispatchEvent(new CustomEvent('app-topbar-detach',{detail:slot}));expect(mounted.parentElement).toBe(document.body);expect(mounted).not.toHaveClass('inline');window.dispatchEvent(new Event('app-topbar-ready'));expect(mounted.parentElement).toBe(slot);
});
