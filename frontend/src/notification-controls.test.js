import { afterEach,expect,it,vi } from 'vitest';
let mounted, listeners = [];
afterEach(()=>{for(const [target,type,listener,options] of listeners)target.removeEventListener(type,listener,options);listeners=[];mounted?.remove();document.body.replaceChildren();if(vi.isFakeTimers())vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();});
async function setup(waiting=false,{mobile=false,reduced=false}={}) {
 vi.stubGlobal('__UPDATES_TEST__',true);Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});
 const sw=new EventTarget();sw.controller={state:'activated'};const worker=new EventTarget();worker.state='installed';worker.postMessage=vi.fn();
 const registration=new EventTarget();Object.assign(registration,{active:sw.controller,waiting:waiting?worker:null,installing:null,update:vi.fn(async()=>{})});sw.register=vi.fn(async()=>registration);
 Object.defineProperty(navigator,'serviceWorker',{value:sw,configurable:true});
 const media=new EventTarget();media.matches=mobile;vi.stubGlobal('matchMedia',vi.fn(query=>query.includes('max-width')?media:{matches:reduced}));
 for(const target of [window,document]){const add=target.addEventListener.bind(target);vi.spyOn(target,'addEventListener').mockImplementation((type,listener,options)=>{listeners.push([target,type,listener,options]);add(type,listener,options);});}
 document.body.innerHTML='<header aria-label="工作区顶栏"><span data-app-notification-controls></span><span>账户</span></header>';
 const {mountUpdates}=await import('../public/app-updates.js');mountUpdates();await Promise.resolve();await Promise.resolve();mounted=document.querySelector('app-updates');return {root:mounted.shadowRoot,worker,media};
}

function notify(id,text,kind='info',action=''){window.dispatchEvent(new CustomEvent('app-notification',{detail:{id,text,kind,action}}));}
function cards(root){return [...root.querySelectorAll('.toast')];}
function pointer(card,type,pointerType='mouse'){const event=new Event(type);Object.defineProperty(event,'pointerType',{value:pointerType});card.dispatchEvent(event);}
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

it('closes full-history actions on the same route, restores bell focus and preserves local update entries',async()=>{
 window.history.replaceState({},'', '/app/settings/notifications');const t=await setup();
 window.dispatchEvent(new CustomEvent('app-notification',{detail:{id:'local-update-fixture',text:'本地更新提示',action:'update'}}));
 const item={id:'831cab18-6eec-4738-a7bb-52f246e3b492',title:'通知推送测试',body:'单次摘要',url:'/app/settings/notifications',createdAt:new Date().toISOString(),readAt:null,dismissedAt:null};
 window.dispatchEvent(new CustomEvent('app-notification-inbox',{detail:{items:[item],unreadCount:1,url:'/app/settings/notifications'}}));
 const bell=t.root.getElementById('bell');bell.click();expect(t.root.getElementById('entries').textContent).toContain('本地更新提示');expect(t.root.getElementById('entries').textContent).toContain('通知推送测试');
 const listener=vi.fn();window.addEventListener('app-notification-open',listener);
 try{Array.from(t.root.querySelectorAll('button')).find(button=>button.textContent==='完整通知历史与设置').click();expect(t.root.getElementById('history').hidden).toBe(true);expect(t.root.activeElement).toBe(bell);expect(listener.mock.calls[0][0].detail).toEqual({url:'/app/settings/notifications',replace:false});await vi.waitFor(()=>expect(window.history.state?.appNotificationPanel).toBeUndefined());}finally{window.removeEventListener('app-notification-open',listener);}
});

it.each([['info',5000,'信息'],['success',5000,'成功'],['warning',7000,'警告'],['error',9000,'错误']])('expires %s banners after their finite duration while preserving history and unread state',async(kind,duration,label)=>{
 vi.useFakeTimers();const t=await setup();notify('notice','有限时通知',kind);
 const card=cards(t.root)[0];expect(card.dataset.kind).toBe(kind);expect(card).toHaveAttribute('aria-label',`${label}通知`);expect(card.querySelector('svg')).not.toBeNull();
 vi.advanceTimersByTime(duration-1);expect(card).not.toHaveClass('leaving');vi.advanceTimersByTime(1);expect(card).toHaveClass('leaving');vi.advanceTimersByTime(180);
 expect(cards(t.root)).toHaveLength(0);expect(t.root.getElementById('toast')).toHaveAttribute('hidden');expect(t.root.getElementById('entries')).toHaveTextContent('有限时通知');expect(t.root.getElementById('bell')).toHaveAttribute('aria-label','通知中心，1 条未读');
});

it('keeps hover and keyboard focus paused independently and resumes only the remaining time',async()=>{
 vi.useFakeTimers();const t=await setup();notify('pause','交互暂停');const card=cards(t.root)[0],close=card.querySelector('.toast-close');
 vi.advanceTimersByTime(2000);pointer(card,'pointerenter');close.focus();pointer(card,'pointerleave');vi.advanceTimersByTime(10000);expect(card).not.toHaveClass('leaving');
 t.root.getElementById('update').focus();vi.advanceTimersByTime(2999);expect(card).not.toHaveClass('leaving');vi.advanceTimersByTime(181);expect(cards(t.root)).toHaveLength(0);
});

it('does not leave a mobile notification paused after a touch enters without hovering',async()=>{
 vi.useFakeTimers();const t=await setup(false,{mobile:true});notify('touch','触屏通知');pointer(cards(t.root)[0],'pointerenter','touch');vi.advanceTimersByTime(5180);expect(cards(t.root)).toHaveLength(0);
});

it('pauses when hidden, closes with reduced motion and restores focus without changing unread state',async()=>{
 vi.useFakeTimers();const t=await setup(false,{reduced:true});notify('pause','后台暂停');const visibility=vi.spyOn(document,'visibilityState','get');
 vi.advanceTimersByTime(1000);visibility.mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));vi.advanceTimersByTime(10000);expect(cards(t.root)).toHaveLength(1);
 visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));const close=cards(t.root)[0].querySelector('.toast-close');close.focus();close.click();expect(cards(t.root)).toHaveLength(0);expect(t.root.activeElement).toBe(t.root.getElementById('bell'));expect(t.root.getElementById('badge')).toHaveTextContent('1');
});

it('limits mobile to one and desktop to two cards, queues in order and preserves focused content on resize',async()=>{
 vi.useFakeTimers();const t=await setup(false,{mobile:true});for(let i=0;i<4;i++)notify(`queue-${i}`,`排队通知${i}`);
 expect(cards(t.root)).toHaveLength(1);expect(cards(t.root)[0]).toHaveTextContent('排队通知0');
 t.media.matches=false;t.media.dispatchEvent(new Event('change'));expect(cards(t.root)).toHaveLength(2);const focused=cards(t.root)[1];focused.querySelector('.toast-close').focus();
 t.media.matches=true;t.media.dispatchEvent(new Event('change'));expect(cards(t.root)).toEqual([focused]);expect(t.root.activeElement).toBe(focused.querySelector('.toast-close'));
 t.root.getElementById('update').focus();vi.advanceTimersByTime(5180);expect(cards(t.root)).toHaveLength(1);expect(cards(t.root)[0]).toHaveTextContent('排队通知0');expect(t.root.getElementById('entries')).toHaveTextContent('排队通知3');
});

it('bounds bursts without losing history, and clears active and queued content on account changes',async()=>{
 vi.useFakeTimers();const t=await setup(false,{mobile:true});for(let i=0;i<20;i++)notify(`burst-${i}`,`突发通知${i}`);
 expect(cards(t.root)).toHaveLength(1);vi.advanceTimersByTime(5180);expect(cards(t.root)[0]).toHaveTextContent('突发通知12');expect(t.root.getElementById('entries')).toHaveTextContent('突发通知1');
 window.dispatchEvent(new CustomEvent('app-notification-scope',{detail:'new-account'}));expect(cards(t.root)).toHaveLength(0);vi.advanceTimersByTime(60000);expect(cards(t.root)).toHaveLength(0);expect(t.root.getElementById('entries')).not.toHaveTextContent('突发通知');
});

it('deduplicates progress, preserves action focus and keeps confirmed update available in history after expiry',async()=>{
 vi.useFakeTimers();const t=await setup(true);const card=cards(t.root)[0];const action=card.querySelector('.toast-action');expect(action).toHaveTextContent('确认更新');action.focus();
 notify('update','新版准备好了','success','update');expect(cards(t.root)).toEqual([card]);expect(t.root.activeElement).toBe(card.querySelector('.toast-action'));expect(t.worker.postMessage).not.toHaveBeenCalled();
 t.root.getElementById('update').focus();vi.advanceTimersByTime(5180);expect(cards(t.root)).toHaveLength(0);expect(t.root.getElementById('entries').querySelector('button')).toHaveTextContent('确认更新');
 t.root.getElementById('bell').click();t.root.getElementById('entries').querySelector('button').click();const dialog=document.querySelector('[role="dialog"]');expect(dialog).not.toBeNull();Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent==='取消').click();await Promise.resolve();await Promise.resolve();expect(t.worker.postMessage).not.toHaveBeenCalled();
});

it('does not overlap the notification center or replay expired installation actions',async()=>{
 vi.useFakeTimers();const t=await setup(false,{mobile:true});notify('install','可安装工作台','info','install');notify('other','另一个通知');notify('install-next','排队的安装','info','install');
 window.dispatchEvent(new Event('app-install-unavailable'));expect(cards(t.root)).toHaveLength(1);expect(cards(t.root)[0]).toHaveTextContent('另一个通知');expect(t.root.getElementById('entries')).not.toHaveTextContent('安装工作台');
 t.root.getElementById('bell').click();notify('new','中心打开期间的新通知');expect(cards(t.root)).toHaveLength(0);expect(t.root.getElementById('history')).not.toHaveAttribute('hidden');expect(t.root.getElementById('entries')).toHaveTextContent('中心打开期间的新通知');vi.advanceTimersByTime(30000);expect(cards(t.root)).toHaveLength(0);
});

it('waits out an old exit timer before showing a new state with the same ID and clears it on scope change',async()=>{
 vi.useFakeTimers();const t=await setup();notify('same','旧状态');vi.advanceTimersByTime(5000);expect(cards(t.root)[0]).toHaveClass('leaving');
 notify('same','新状态','warning');expect(cards(t.root)).toHaveLength(1);vi.advanceTimersByTime(180);expect(cards(t.root)).toHaveLength(1);expect(cards(t.root)[0]).toHaveTextContent('新状态');vi.advanceTimersByTime(1000);expect(t.root.getElementById('toast')).not.toHaveAttribute('hidden');
 window.dispatchEvent(new CustomEvent('app-notification-scope',{detail:'another-account'}));notify('fresh','新账户通知');vi.advanceTimersByTime(7000);expect(cards(t.root)).toHaveLength(0);expect(t.root.getElementById('entries')).not.toHaveTextContent('新状态');
});
