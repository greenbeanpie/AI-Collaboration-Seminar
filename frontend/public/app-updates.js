import { confirmInPage } from './in-page-dialog.js';
// Shared by authenticated, login and static guest shells. No account data is persisted.
export class UpdateController {
  constructor(env, publish) {
    this.env = env;
    this.publish = publish;
    this.state = 'idle';
    this.registration = null;
    this.applying = false;
    this.reloaded = false;
    this.changedElsewhere = false;
    this.activationTarget = null;
    this.stopWatchingActivation = null;
    this.watched = new WeakSet();
    env.sw?.addEventListener('controllerchange', () => {
      if (this.applying) this.reloadWhenControlled();
      else if (this.hadController) { this.changedElsewhere = true; this.set('ready'); }
      this.hadController = true;
    });
    this.hadController = Boolean(env.sw?.controller);
  }
  set(state) {
    this.env.clearTimeout(this.progressTimer);
    this.state = state;
    this.publish(state);
    if (state === 'downloading') this.progressTimer = this.env.setTimeout(() => this.set('error'), 120000);
  }
  async bounded(operation) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = this.env.setTimeout(() => reject(new Error('timeout')), 30000); })]); }
    finally { this.env.clearTimeout(timer); }
  }
  async start() {
    if (!this.env.sw || !this.env.enabled) { this.set(this.resourcesMissing && this.env.online() ? 'refresh' : 'unsupported'); return; }
    if (this.starting) return this.starting;
    this.starting = this.bounded(this.env.sw.register('/sw.js', { scope: '/', updateViaCache: 'none' })).then(registration => {
      this.registration = registration;
      registration.addEventListener('updatefound', () => this.inspect());
      this.inspect();
    }).catch(() => this.set(this.env.online() ? (this.resourcesMissing ? 'refresh' : 'error') : 'offline')).finally(() => { this.starting = null; });
    return this.starting;
  }
  inspect() {
    const registration = this.registration;
    if (!registration || this.applying) return;
    if (registration.waiting && (registration.active || this.hadController)) { this.set('ready'); return; }
    const worker = registration.installing;
    if (!worker) return;
    const isUpdate = Boolean(registration.active || this.hadController);
    if (isUpdate) this.set('downloading');
    if (this.watched.has(worker)) return;
    this.watched.add(worker);
    worker.addEventListener('statechange', () => {
      if (this.applying) return;
      if (worker.state === 'installed') this.set(isUpdate ? 'ready' : 'latest');
      if (worker.state === 'redundant') this.set('error');
    });
  }
  async check() {
    if (this.applying || this.checking || this.state === 'downloading') return;
    if (this.registration?.waiting || this.changedElsewhere) { this.set('ready'); return; }
    if (!this.env.online()) { this.set('offline'); return; }
    if (!this.env.sw || !this.env.enabled) { this.set(this.resourcesMissing ? 'refresh' : 'unsupported'); return; }
    this.checking = true;
    this.set('checking');
    try {
      if (!this.registration) await this.start();
      if (!this.registration) return;
      await this.bounded(this.registration.update());
      this.inspect();
      if (!this.registration.installing && !this.registration.waiting && !this.changedElsewhere) this.set(this.resourcesMissing ? 'refresh' : 'latest');
    } catch { this.set(this.env.online() ? (this.resourcesMissing ? 'refresh' : 'error') : 'offline'); }
    finally { this.checking = false; }
  }
  async apply() {
    if (this.applying || this.confirming || !['ready', 'refresh'].includes(this.state)) return;
    this.confirming = true;
    let confirmed;
    try { confirmed = await this.env.confirm('更新将重新加载页面。请先保存未提交的编辑、草稿和附件。确认现在更新？'); }
    catch { this.set('error'); return; }
    finally { this.confirming = false; }
    if (!confirmed || this.applying || !['ready', 'refresh'].includes(this.state)) return;
    const worker = this.registration?.waiting;
    const confirmedRefresh = this.state === 'refresh' && this.resourcesMissing;
    if (!worker && !this.changedElsewhere && !confirmedRefresh) { this.set('error'); return; }
    this.applying = true;
    this.set('applying');
    if (confirmedRefresh && !worker) { this.reloadOnce(); return; }
    if (this.changedElsewhere && !worker) { this.watchActivation(this.env.sw?.controller); return; }
    this.watchActivation(worker);
    try { worker.postMessage({ type: 'SKIP_WAITING' }); }
    catch { this.cancelActivation(); this.applying = false; this.set('error'); }
  }
  watchActivation(worker) {
    if (!worker) { this.applying = false; this.set('error'); return; }
    this.activationTarget = worker;
    const activated = () => this.reloadWhenControlled();
    worker.addEventListener('statechange', activated);
    this.stopWatchingActivation = () => worker.removeEventListener('statechange', activated);
    this.applyTimer = this.env.setTimeout(() => {
      this.cancelActivation();
      if (!this.reloaded) { this.applying = false; this.set('error'); }
    }, 20000);
    this.reloadWhenControlled();
  }
  reloadWhenControlled() {
    // Activation alone does not mean this document has left its old controller.
    // Claiming can also precede the end of activate/cache cleanup. Wait for both.
    if (this.activationTarget?.state === 'activated' && this.env.sw?.controller === this.activationTarget) this.reloadOnce();
  }
  cancelActivation() {
    this.env.clearTimeout(this.applyTimer);
    this.stopWatchingActivation?.();
    this.stopWatchingActivation = null;
    this.activationTarget = null;
  }
  reloadOnce() {
    if (!this.applying || this.reloaded) return;
    this.reloaded = true;
    this.cancelActivation();
    this.env.reload();
  }
}

export class NotificationHistory {
  constructor() { this.items = []; this.scope = ''; }
  reset(scope) { if (scope !== this.scope) { this.scope = scope; this.items = []; } }
  add(id, text, kind = 'info', action = '', metadata = {}) {
    const item = { id, text, kind, action, time: Date.now(), unread: true, ...metadata };
    this.items = [item, ...this.items.filter(old => old.id !== id)].slice(0, 30);
    return item;
  }
}

const labels = { idle: '检查更新', checking: '检查中…', latest: '已是最新 · 再检查', downloading: '正在下载…', ready: '下载完成 · 更新', applying: '正在更新…', error: '更新失败 · 重试', offline: '离线 · 重试', unsupported: '当前环境不支持更新' };
const details = { checking: '正在检查应用更新。', latest: '当前已是最新版本。', downloading: '发现新版本，正在下载。完成后可手动确认更新。', ready: '新版本已就绪。请保存编辑后确认重新加载。', applying: '正在应用已确认的更新。', error: '更新未完成，请稍后重试。页面编辑仍保留。', offline: '当前离线，联网后可重试检查更新。', unsupported: '当前浏览器或开发环境不支持应用更新。' };

const noticeKinds = {
  info: { label: '信息', duration: 5000, path: 'M12 11v6M12 7h.01', shape: 'circle' },
  success: { label: '成功', duration: 5000, path: 'm7 12 3 3 7-7', shape: 'circle' },
  warning: { label: '警告', duration: 7000, path: 'M12 9v4M12 17h.01M12 3 2 21h20Z' },
  error: { label: '错误', duration: 9000, path: 'm9 9 6 6m0-6-6 6', shape: 'circle' },
};

labels.refresh = '页面资源不可用 · 重新加载';
details.refresh = '页面资源加载失败。请先保存编辑，再确认重新加载；取消会保留页面。';

export function mountUpdates() {
  if (document.querySelector('app-updates')) return;
  const host = document.createElement('app-updates');
  document.body.prepend(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{display:block;position:sticky;top:0;z-index:60;font:13px/1.5 system-ui;color:var(--ink,var(--fg,#243447));background:var(--surface,var(--bg,rgb(var(--surface-rgb,255 255 255))));border-bottom:1px solid #a0a0a040;color-scheme:inherit}
    :host(.inline){display:inline-flex;position:relative;top:auto;background:transparent;border:0;flex:none}
    :host(.inline) .bar{padding:0;min-height:36px;gap:4px;flex-wrap:nowrap}
    :host(.inline) .panel{position:fixed;top:var(--app-toast-top,60px);right:12px}
    .control{position:relative;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-color:transparent}
    .control:hover{background:#a0a0a018}.control svg{width:19px;height:19px;flex:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .count{position:absolute;top:0;right:-1px;min-width:15px;padding:0 3px;height:15px;line-height:15px;background:#c54949;color:#fff;border-radius:10px;font-size:10px;font-weight:700}
    .count:empty{display:none}.update-status{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#398565;display:none}
    #update[data-state=ready] .update-status{display:block}#update[data-state=checking] svg,#update[data-state=downloading] svg,#update[data-state=applying] svg{animation:control-spin 1.2s linear infinite}
    @keyframes control-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#update svg{animation:none!important}}
    *{box-sizing:border-box} .bar{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:7px 16px;min-height:46px}
    button{font:inherit;color:inherit;background:transparent;border:1px solid #a0a0a060;border-radius:8px;padding:6px 10px;min-height:32px;cursor:pointer}button:focus-visible{outline:2px solid #3978c6;outline-offset:2px}button:disabled{cursor:wait;opacity:.65}
    .panel{position:absolute;right:12px;top:100%;width:min(420px,calc(100vw - 24px));max-height:65vh;overflow:auto;background:var(--surface,var(--bg,rgb(var(--surface-rgb,255 255 255))));color:var(--ink,var(--fg,#243447));border:1px solid #a0a0a060;border-radius:12px;padding:12px;box-shadow:0 10px 25px #0002}
    [hidden]{display:none!important}.entry{padding:10px 0;border-bottom:1px solid #a0a0a030;overflow-wrap:anywhere}.meta{font-size:11px;opacity:.85;color:var(--notice-accent,inherit)}.panel-head{display:flex;justify-content:space-between;align-items:center}
    [data-kind=info]{--notice-accent:#245eb5;--notice-accent:light-dark(#245eb5,#96c0ff);--notice-bg:light-dark(#eef5ff,#192c48)}
    [data-kind=success]{--notice-accent:#1b7453;--notice-accent:light-dark(#1b7453,#8bddb9);--notice-bg:light-dark(#edf8f2,#18382d)}
    [data-kind=warning]{--notice-accent:#8b5805;--notice-accent:light-dark(#8b5805,#f4ca78);--notice-bg:light-dark(#fff6e4,#3c301b)}
    [data-kind=error]{--notice-accent:#b52f45;--notice-accent:light-dark(#b52f45,#ffacb9);--notice-bg:light-dark(#fff0f2,#402532)}
    .toast-shelf{position:fixed;z-index:70;top:max(calc(env(safe-area-inset-top,0px) + 12px),calc(var(--app-toast-top,46px) + 10px));right:max(16px,env(safe-area-inset-right,0px));width:min(400px,calc(100vw - 24px - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px)));display:grid;gap:10px;pointer-events:none}
    .toast{pointer-events:auto;display:grid;grid-template-columns:24px minmax(0,1fr) 44px;align-items:start;gap:10px;padding:12px 6px 12px 14px;border:1px solid var(--notice-accent);border-inline-start-width:4px;border-radius:18px;background:var(--paper,var(--surface,#fff));background:var(--notice-bg);color:var(--ink,var(--fg,#243447));box-shadow:0 8px 28px #0003;animation:toast-enter .22s ease-out both}
    .toast-icon{width:24px;height:24px;margin-top:2px;color:var(--notice-accent)}.toast-content{min-width:0}.toast-title{display:block;color:var(--notice-accent);font-size:13px;margin-bottom:3px}.toast-text{font-size:14px;line-height:1.55;overflow-wrap:anywhere;max-height:min(96px,14dvh);overflow:auto}.toast-action{margin-top:9px;min-height:44px;color:var(--notice-accent);border-color:var(--notice-accent)}.toast-close{display:grid;place-items:center;min-width:44px;min-height:44px;padding:0;border:0;border-radius:12px;font-size:23px;line-height:1;color:var(--notice-accent)}.toast-close:hover{background:#80808018}
    .toast.leaving{animation:toast-leave .18s ease-in both;pointer-events:none}
    @keyframes toast-enter{from{opacity:0;transform:translateY(-14px) scale(.98)}to{opacity:1;transform:none}}@keyframes toast-leave{to{opacity:0;transform:translateY(-10px)}}
    @media(max-width:600px){.toast-shelf{right:max(12px,env(safe-area-inset-right,0px))}.toast{border-radius:16px}}
    @media(prefers-reduced-motion:reduce){.toast,.toast.leaving{animation:none}}
    @media(max-width:500px){.bar{padding:6px 10px}}@media print{:host{display:none}}
  </style><div class="bar"><button id="update" class="control" type="button" aria-label="检查更新" title="检查更新"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg><span class="update-status" aria-hidden="true"></span><span id="update-label" class="sr-only">检查更新</span></button><button id="bell" class="control" type="button" title="通知中心" aria-label="通知中心" aria-expanded="false" aria-controls="history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span id="badge" class="count" aria-hidden="true"></span></button></div><div id="toast" class="toast-shelf" hidden></div><div id="announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div><section id="history" class="panel" hidden aria-label="通知中心"><div class="panel-head"><strong>通知中心</strong><button id="close" type="button">关闭</button></div><div id="entries"></div></section>`;
  const find = id => root.getElementById(id);
  function layoutControls() {
    const inline = host.classList.contains('inline');
    document.documentElement.style.setProperty('--app-notification-height', inline ? '0px' : `${host.getBoundingClientRect().height}px`);
    const bottom = host.closest('header')?.getBoundingClientRect().bottom ?? host.getBoundingClientRect().bottom;
    host.style.setProperty('--app-toast-top', `${Math.max(0,bottom)}px`);
  }
  const attachControls = () => {
    const slot = document.querySelector('[data-app-notification-controls]');
    if (slot) { if (host.parentElement !== slot) slot.append(host); host.classList.add('inline'); }
    else { host.classList.remove('inline'); if (host.parentElement !== document.body) document.body.prepend(host); }
    layoutControls();
  };
  window.addEventListener('app-topbar-ready', attachControls);
  window.addEventListener('app-topbar-detach', event => {
    if (host.parentElement !== event.detail) return;
    host.classList.remove('inline'); document.body.prepend(host); layoutControls();
  });
  window.addEventListener('resize', layoutControls);
  window.addEventListener('scroll', layoutControls, true);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layoutControls).observe(host);
  attachControls();
  const history = new NotificationHistory();
  let inboxUrl = '/app/settings/notifications', inboxUnread = 0;
  let open = false, sequence = 0;
  const visible = new Map(), pending = [];
  const narrow = window.matchMedia?.('(max-width: 600px)');
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const panelHistoryKey = `notifications-${Date.now()}`;
  const env = { sw: navigator.serviceWorker, enabled: !document.querySelector('script[src*="/@vite/client"]') && window.isSecureContext,
    online: () => navigator.onLine, confirm: confirmInPage,
    setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: timer => window.clearTimeout(timer),
    reload: () => { window.dispatchEvent(new Event('app-update-reload')); location.reload(); } };
  const controller = new UpdateController(env, state => {
    find('update-label').textContent = labels[state];
    find('update').title = labels[state]; find('update').setAttribute('aria-label',labels[state]); find('update').dataset.state = state;
    find('update').disabled = ['checking', 'downloading', 'applying'].includes(state);
    if (state !== 'idle') notify('update', details[state], state === 'error' ? 'error' : ['offline', 'refresh'].includes(state) ? 'warning' : ['latest', 'ready'].includes(state) ? 'success' : 'info', 'update');
  });
  const actionButton = item => {
    const button = document.createElement('button');
    button.type = 'button';
    if (item.action === 'update' && controller.state === 'refresh') { button.textContent = '确认重新加载'; button.onclick = () => controller.apply(); return button; }
    if (item.action === 'update' && controller.state === 'ready') { button.textContent = '确认更新'; button.onclick = () => controller.apply(); }
    else if (item.url || item.action === 'inbox') { button.textContent = '查看通知'; button.onclick = () => {
      const url=item.url||inboxUrl;
      const samePage=new URL(url,location.href).href===location.href;
      const panelEntry=open&&window.history.state?.appNotificationPanel===panelHistoryKey;
      closePanel(true,samePage);
      window.dispatchEvent(new CustomEvent('app-notification-open',{detail:{url,replace:panelEntry&&!samePage}}));
    }; }
    else if (item.action === 'install') { button.textContent = '安装到桌面'; button.onclick = () => window.dispatchEvent(new Event('app-install-request')); }
    else return null;
    return button;
  };
  function render() {
    const unread = inboxUnread + history.items.filter(item => !item.remoteId && item.unread).length;
    find('badge').textContent = unread ? unread > 99 ? '99+' : String(unread) : '';
    find('bell').title = find('bell').ariaLabel = unread ? `通知中心，${unread} 条未读` : '通知中心';
    find('entries').replaceChildren();
    if (!history.items.length) find('entries').textContent = '暂无通知。账户通知历史可在设置的推送与通知页面查看。';
    for (const item of history.items.filter(item => !item.dismissedAt)) {
      const entry = document.createElement('div'); entry.className = 'entry'; entry.dataset.kind = item.kind;
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${noticeKinds[item.kind]?.label || '信息'} · ${new Date(item.time).toLocaleTimeString()}`;
      const text = document.createElement('div'); text.textContent = item.text;
      entry.append(meta, text); const action = actionButton(item); if (action) entry.append(action);
      if (item.remoteId) {
        for (const state of item.unread ? ['read', 'dismiss'] : ['dismiss']) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = state === 'read' ? '标记已读' : '收起提醒';
          button.onclick = () => window.dispatchEvent(new CustomEvent('app-notification-state', { detail: { id: item.remoteId, action: state } })); entry.append(button);
        }
      }
      find('entries').append(entry);
    }
    if (history.items.some(item => item.remoteId)) { const more = actionButton({ action: 'inbox' }); more.textContent = '完整通知历史与设置'; find('entries').append(more); }
  }
  function pause(notice) {
    if (notice.timer == null) return;
    clearTimeout(notice.timer); notice.timer = null;
    notice.remaining = Math.max(0, notice.remaining - (Date.now() - notice.started));
  }
  function resume(notice) {
    if (notice.closing || notice.hovered || notice.focused || document.visibilityState === 'hidden') return;
    clearTimeout(notice.timer); notice.started = Date.now();
    notice.timer = setTimeout(() => dismiss(notice), notice.remaining);
  }
  function dismiss(notice, immediate = false) {
    if (!notice || notice.closing) return;
    pause(notice); notice.closing = true;
    if (notice.card.contains(root.activeElement)) find('bell').focus();
    const remove = () => { notice.card.remove(); if (visible.get(notice.item.id) === notice) visible.delete(notice.item.id); drain(); };
    if (immediate || reducedMotion()) remove();
    else { notice.card.classList.add('leaving'); notice.exitTimer = setTimeout(remove, 180); }
  }
  function clearToasts() {
    pending.length = 0;
    for (const notice of visible.values()) { clearTimeout(notice.timer); clearTimeout(notice.exitTimer); notice.card.remove(); }
    visible.clear(); find('toast').hidden = true; find('announcement').textContent = '';
  }
  function updateCard(notice) {
    const { item, card } = notice, kind = noticeKinds[item.kind];
    card.dataset.kind = item.kind; card.setAttribute('aria-label', `${kind.label}通知`);
    card.querySelector('.toast-title').textContent = kind.label;
    card.querySelector('.toast-text').textContent = item.text;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    if (kind.shape) { const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9'); svg.append(circle); }
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', kind.path); svg.append(path);
    card.querySelector('.toast-icon').replaceChildren(svg);
    const oldAction = card.querySelector('.toast-action'), focused = oldAction && root.activeElement === oldAction;
    const action = actionButton(item);
    oldAction?.remove();
    if (action) { action.className = 'toast-action'; card.querySelector('.toast-content').append(action); }
    if (focused) (action || card.querySelector('.toast-close')).focus();
    find('announcement').textContent = `${kind.label}：${item.text}`;
  }
  function show(item, remaining = noticeKinds[item.kind].duration) {
    const card = document.createElement('section'); card.className = 'toast'; card.setAttribute('role', 'group');
    card.innerHTML = '<div class="toast-icon"></div><div class="toast-content"><strong class="toast-title"></strong><div class="toast-text"></div></div><button type="button" class="toast-close" aria-label="关闭通知" title="关闭通知">×</button>';
    const notice = { item, card, remaining, timer: null, hovered: false, focused: false, closing: false };
    visible.set(item.id, notice); updateCard(notice); find('toast').append(card); find('toast').hidden = false;
    // Touch taps can synthesize mouseenter without a matching leave; only real hover pauses.
    card.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') { notice.hovered = true; pause(notice); } });
    card.addEventListener('pointerleave', () => { notice.hovered = false; resume(notice); });
    card.addEventListener('focusin', () => { notice.focused = true; pause(notice); });
    card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget)) { notice.focused = false; resume(notice); } });
    card.querySelector('.toast-close').onclick = () => dismiss(notice);
    card.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(notice); } });
    resume(notice);
  }
  function drain() {
    if (open) return;
    while (pending.length && visible.size < (narrow?.matches ? 1 : 2)) {
      // An ID still leaving occupies its slot until its old timer is fully cleaned up.
      const index = pending.findIndex(next => !visible.has(next.item.id));
      if (index === -1) break;
      const [next] = pending.splice(index, 1); show(next.item, next.remaining);
    }
    find('toast').hidden = visible.size === 0;
  }
  narrow?.addEventListener('change', () => {
    // Preserve a focused card when resizing; put other cards back in the bounded queue.
    if (narrow.matches && visible.size > 1) {
      const keep = [...visible.values()].find(notice => notice.focused) || visible.values().next().value;
      for (const notice of visible.values()) if (notice !== keep) { pause(notice); clearTimeout(notice.exitTimer); notice.card.remove(); visible.delete(notice.item.id); if (!notice.closing) pending.unshift({ item: notice.item, remaining: notice.remaining }); }
      pending.splice(8);
    }
    drain();
  });
  document.addEventListener('visibilitychange', () => { for (const notice of visible.values()) { if (document.visibilityState === 'hidden') pause(notice); else resume(notice); } });
  function notify(id, text, kind = 'info', action = '') {
    if (typeof text !== 'string' || !text.trim()) return;
    kind = Object.hasOwn(noticeKinds, kind) ? kind : 'info';
    const item = history.add(id, text, kind, action);
    if (open) item.unread = false;
    const notice = visible.get(id);
    if (notice && !notice.closing) { pause(notice); notice.item = item; notice.remaining = noticeKinds[kind].duration; updateCard(notice); resume(notice); }
    else if (!open) {
      const queued = pending.find(entry => entry.item.id === id);
      if (queued) { queued.item = item; queued.remaining = noticeKinds[kind].duration; }
      else { if (pending.length === 8) pending.shift(); pending.push({ item, remaining: noticeKinds[kind].duration }); }
      drain();
    }
    render();
  }
  function closePanel(focus = true, unwind = true) {
    const wasOpen = open;
    open = false; find('history').hidden = true; find('bell').setAttribute('aria-expanded', 'false');
    if (focus) find('bell').focus();
    if (wasOpen && unwind && window.history.state?.appNotificationPanel === panelHistoryKey) window.history.back();
  }
  find('bell').onclick = () => {
    if (open) { closePanel(); return; }
    open = true;
    clearToasts();
    // Same-URL entry: Back dismisses the panel without leaving an edited form.
    const previous = window.history.state ?? {};
    window.history.pushState({ ...previous, idx: typeof previous.idx === 'number' ? previous.idx + 1 : previous.idx, appNotificationPanel: panelHistoryKey }, '', location.href);
    history.items.forEach(item => { if (!item.remoteId) item.unread = false; }); render(); find('history').hidden = false; find('bell').setAttribute('aria-expanded', 'true'); find('close').focus();
  };
  find('close').onclick = () => closePanel();
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && open) { event.stopPropagation(); closePanel(); } });
  document.addEventListener('pointerdown', event => { if (open && !event.composedPath().includes(host)) closePanel(); });
  window.addEventListener('popstate', () => { if (open) closePanel(true, false); });
  find('update').onclick = () => ['ready', 'refresh'].includes(controller.state) ? controller.apply() : void controller.check();
  window.addEventListener('app-update-request', () => {
    if (['ready', 'refresh'].includes(controller.state)) controller.apply();
    else void controller.check().then(() => { if (['ready', 'refresh'].includes(controller.state)) controller.apply(); });
  });
  window.addEventListener('app-assets-unavailable', () => {
    controller.resourcesMissing = true;
    notify('assets', '页面资源暂时不可用。请先保存编辑，再检查并确认更新；页面不会自动重载。', 'error');
    void controller.check();
  });
  window.addEventListener('offline', () => notify('network', '当前离线。请保留未提交的编辑，联网后检查并确认提交。', 'warning'));
  window.addEventListener('online', () => notify('network', '网络已恢复，可以检查更新。', 'success'));
  window.addEventListener('app-notification-scope', event => {
    if (history.scope === event.detail) return;
    history.reset(event.detail); inboxUnread = 0; clearToasts(); closePanel(false);
    // System update readiness is not account content; expose the current action after a scope switch.
    if (['ready', 'refresh', 'downloading', 'applying'].includes(controller.state)) history.add('update', details[controller.state], 'info', 'update');
    window.dispatchEvent(new Event('app-install-status-request'));
    render();
  });
  window.addEventListener('app-notification-inbox', event => {
    const detail = event.detail;
    if (!detail || !Array.isArray(detail.items)) return;
    inboxUrl = typeof detail.url === 'string' ? detail.url : inboxUrl;
    inboxUnread = Number.isSafeInteger(detail.unreadCount) ? detail.unreadCount : detail.items.filter(item => !item.readAt && !item.dismissedAt).length;
    const remote = detail.items.filter(item => typeof item.id === 'string').map(item => ({ id: `server:${item.id}`, remoteId: item.id, text: `${item.title} ${item.body}`, kind: 'info', action: '', url: item.url, time: Date.parse(item.createdAt), unread: !item.readAt && !item.dismissedAt, dismissedAt: item.dismissedAt }));
    history.items = [...remote, ...history.items.filter(item => !item.remoteId)].sort((a, b) => b.time - a.time).slice(0, 80);
    render();
  });
  window.addEventListener('app-notification', event => {
    // Callers send only allowlisted summaries, never provider responses or private content.
    const { text, kind = 'info', id, action = '' } = event.detail || {};
    notify(id || `notice-${++sequence}`, text, kind, action);
  });
  function removeInstallToasts() {
    for (let index = pending.length - 1; index >= 0; index--) if (pending[index].item.action === 'install') pending.splice(index, 1);
    for (const notice of visible.values()) if (notice.item.action === 'install') dismiss(notice, true);
  }
  window.addEventListener('app-install-unavailable', () => { history.items = history.items.filter(item => item.action !== 'install'); removeInstallToasts(); render(); });
  window.addEventListener('app-install-state', event => {
    if (event.detail === true) {
      if (!history.items.some(item => item.action === 'install')) history.add('install', '安装工作台可获得独立窗口和桌面入口。', 'info', 'install');
    } else {
      history.items = history.items.filter(item => item.action !== 'install');
      removeInstallToasts();
    }
    render();
  });
  window.dispatchEvent(new Event('app-install-status-request'));
  render(); void controller.start();
}

if (typeof window !== 'undefined' && !globalThis.__UPDATES_TEST__) mountUpdates();
