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
    this.watched = new WeakSet();
    env.sw?.addEventListener('controllerchange', () => {
      if (this.applying) this.reloadOnce();
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
  apply() {
    if (this.applying || !['ready', 'refresh'].includes(this.state)) return;
    if (!this.env.confirm('更新将重新加载页面。请先保存未提交的编辑、草稿和附件。确认现在更新？')) return;
    const worker = this.registration?.waiting;
    const confirmedRefresh = this.state === 'refresh' && this.resourcesMissing;
    if (!worker && !this.changedElsewhere && !confirmedRefresh) { this.set('error'); return; }
    this.applying = true;
    this.set('applying');
    if ((this.changedElsewhere || confirmedRefresh) && !worker) { this.reloadOnce(); return; }
    // Never reload on an unsolicited activation in another tab.
    const activated = () => { if (worker.state === 'activated' && this.applying) this.reloadOnce(); };
    worker.addEventListener('statechange', activated);
    this.applyTimer = this.env.setTimeout(() => {
      worker.removeEventListener('statechange', activated);
      if (!this.reloaded) { this.applying = false; this.set('error'); }
    }, 20000);
    try { worker.postMessage({ type: 'SKIP_WAITING' }); }
    catch { this.env.clearTimeout(this.applyTimer); this.applying = false; this.set('error'); }
  }
  reloadOnce() {
    if (!this.applying || this.reloaded) return;
    this.reloaded = true;
    this.env.clearTimeout(this.applyTimer);
    this.env.reload();
  }
}

export class NotificationHistory {
  constructor() { this.items = []; this.scope = ''; }
  reset(scope) { if (scope !== this.scope) { this.scope = scope; this.items = []; } }
  add(id, text, kind = 'info', action = '') {
    const item = { id, text, kind, action, time: Date.now(), unread: true };
    this.items = [item, ...this.items.filter(old => old.id !== id)].slice(0, 30);
    return item;
  }
}

const labels = { idle: '检查更新', checking: '检查中…', latest: '已是最新 · 再检查', downloading: '正在下载…', ready: '下载完成 · 更新', applying: '正在更新…', error: '更新失败 · 重试', offline: '离线 · 重试', unsupported: '当前环境不支持更新' };
const details = { checking: '正在检查应用更新。', latest: '当前已是最新版本。', downloading: '发现新版本，正在下载。完成后可手动确认更新。', ready: '新版本已就绪。请保存编辑后确认重新加载。', applying: '正在应用已确认的更新。', error: '更新未完成，请稍后重试。页面编辑仍保留。', offline: '当前离线，联网后可重试检查更新。', unsupported: '当前浏览器或开发环境不支持应用更新。' };

labels.refresh = '页面资源不可用 · 重新加载';
details.refresh = '页面资源加载失败。请先保存编辑，再确认重新加载；取消会保留页面。';

export function mountUpdates() {
  if (document.querySelector('app-updates')) return;
  const host = document.createElement('app-updates');
  document.body.prepend(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{display:block;position:sticky;top:0;z-index:60;font:13px/1.5 system-ui;color:var(--ink,var(--fg,#243447));background:var(--surface,var(--bg,rgb(var(--surface-rgb,255 255 255))));border-bottom:1px solid #a0a0a040;color-scheme:light dark}
    *{box-sizing:border-box} .bar{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:7px 16px;min-height:46px}
    button{font:inherit;color:inherit;background:transparent;border:1px solid #a0a0a060;border-radius:8px;padding:6px 10px;min-height:32px;cursor:pointer}button:focus-visible{outline:2px solid #3978c6;outline-offset:2px}button:disabled{cursor:wait;opacity:.65}
    .panel{position:absolute;right:12px;top:100%;width:min(420px,calc(100vw - 24px));max-height:65vh;overflow:auto;background:var(--surface,var(--bg,rgb(var(--surface-rgb,255 255 255))));color:var(--ink,var(--fg,#243447));border:1px solid #a0a0a060;border-radius:12px;padding:12px;box-shadow:0 10px 25px #0002}
    [hidden]{display:none!important}.entry{padding:10px 0;border-bottom:1px solid #a0a0a030;overflow-wrap:anywhere}.meta{font-size:11px;opacity:.7}.toast{padding:10px 16px;display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}.toast span{max-width:650px}.panel-head{display:flex;justify-content:space-between;align-items:center}
    @media(max-width:500px){.bar{padding:6px 10px}.toast{justify-content:flex-start}}@media print{:host{display:none}}
  </style><div class="bar"><button id="update" type="button">检查更新</button><button id="bell" type="button" aria-expanded="false" aria-controls="history">通知 <span id="badge"></span></button></div><div id="toast" class="toast" hidden role="status" aria-live="polite" aria-atomic="true"></div><section id="history" class="panel" hidden aria-label="通知中心"><div class="panel-head"><strong>通知中心</strong><button id="close" type="button">关闭</button></div><div id="entries"></div></section>`;
  const find = id => root.getElementById(id);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    document.documentElement.style.setProperty('--app-notification-height', `${host.getBoundingClientRect().height}px`);
  }).observe(host);
  const history = new NotificationHistory();
  let open = false, timer, remaining = 5000, started = 0, active = null, sequence = 0;
  const panelHistoryKey = `notifications-${Date.now()}`;
  const env = { sw: navigator.serviceWorker, enabled: !document.querySelector('script[src*="/@vite/client"]') && window.isSecureContext,
    online: () => navigator.onLine, confirm: message => window.confirm(message),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: timer => window.clearTimeout(timer),
    reload: () => { window.dispatchEvent(new Event('app-update-reload')); location.reload(); } };
  const controller = new UpdateController(env, state => {
    find('update').textContent = labels[state];
    find('update').disabled = ['checking', 'downloading', 'applying'].includes(state);
    if (state !== 'idle') notify('update', details[state], state === 'error' ? 'error' : 'info', 'update');
  });
  const actionButton = item => {
    const button = document.createElement('button');
    button.type = 'button';
    if (item.action === 'update' && controller.state === 'refresh') { button.textContent = '确认重新加载'; button.onclick = () => controller.apply(); return button; }
    if (item.action === 'update' && controller.state === 'ready') { button.textContent = '确认更新'; button.onclick = () => controller.apply(); }
    else if (item.action === 'install') { button.textContent = '安装到桌面'; button.onclick = () => window.dispatchEvent(new Event('app-install-request')); }
    else return null;
    return button;
  };
  function render() {
    find('badge').textContent = history.items.some(item => item.unread) ? `(${history.items.filter(item => item.unread).length})` : '';
    find('entries').replaceChildren();
    if (!history.items.length) find('entries').textContent = '暂无通知。仅保存当前页面会话的最近 30 条通知。';
    for (const item of history.items) {
      const entry = document.createElement('div'); entry.className = 'entry';
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${item.kind === 'error' ? '错误' : item.kind === 'success' ? '成功' : '提示'} · ${new Date(item.time).toLocaleTimeString()}`;
      const text = document.createElement('div'); text.textContent = item.text;
      entry.append(meta, text); const action = actionButton(item); if (action) entry.append(action);
      find('entries').append(entry);
    }
  }
  function dismiss() { clearTimeout(timer); active = null; find('toast').hidden = true; }
  function resume() { clearTimeout(timer); started = Date.now(); timer = setTimeout(dismiss, remaining); }
  function pause() { if (!timer) return; clearTimeout(timer); timer = null; remaining = Math.max(0, remaining - (Date.now() - started)); }
  find('toast').addEventListener('mouseenter', pause);
  find('toast').addEventListener('mouseleave', () => { if (!find('toast').contains(root.activeElement)) resume(); });
  find('toast').addEventListener('focusin', pause);
  find('toast').addEventListener('focusout', event => { if (!find('toast').contains(event.relatedTarget) && !find('toast').matches(':hover')) resume(); });
  function notify(id, text, kind = 'info', action = '') {
    const item = history.add(id, text, kind, action);
    if (open) item.unread = false;
    active = item;
    find('toast').replaceChildren();
    const content = document.createElement('span'); content.textContent = text; find('toast').append(content);
    const button = actionButton(item); if (button) find('toast').append(button);
    const close = document.createElement('button'); close.textContent = '关闭'; close.setAttribute('aria-label', '关闭通知'); close.onclick = dismiss; find('toast').append(close);
    find('toast').hidden = false; remaining = 5000; resume(); render();
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
    // Same-URL entry: Back dismisses the panel without leaving an edited form.
    const previous = window.history.state ?? {};
    window.history.pushState({ ...previous, idx: typeof previous.idx === 'number' ? previous.idx + 1 : previous.idx, appNotificationPanel: panelHistoryKey }, '', location.href);
    history.items.forEach(item => { item.unread = false; }); render(); find('history').hidden = false; find('bell').setAttribute('aria-expanded', 'true'); find('close').focus();
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
  window.addEventListener('offline', () => notify('network', '当前离线。请保留未提交的编辑，联网后检查并确认提交。'));
  window.addEventListener('online', () => notify('network', '网络已恢复，可以检查更新。'));
  window.addEventListener('app-notification-scope', event => {
    if (history.scope === event.detail) return;
    history.reset(event.detail); dismiss(); closePanel(false);
    // System update readiness is not account content; expose the current action after a scope switch.
    if (['ready', 'refresh', 'downloading', 'applying'].includes(controller.state)) history.add('update', details[controller.state], 'info', 'update');
    window.dispatchEvent(new Event('app-install-status-request'));
    render();
  });
  window.addEventListener('app-notification', event => {
    // Callers send only allowlisted summaries, never provider responses or private content.
    const { text, kind = 'info', id, action = '' } = event.detail;
    notify(id || `notice-${++sequence}`, text, kind, action);
  });
  window.addEventListener('app-install-unavailable', () => { history.items = history.items.filter(item => item.action !== 'install'); if (active?.action === 'install') dismiss(); render(); });
  window.addEventListener('app-install-state', event => {
    if (event.detail === true) {
      if (!history.items.some(item => item.action === 'install')) history.add('install', '安装工作台可获得独立窗口和桌面入口。', 'info', 'install');
    } else {
      history.items = history.items.filter(item => item.action !== 'install');
      if (active?.action === 'install') dismiss();
    }
    render();
  });
  window.dispatchEvent(new Event('app-install-status-request'));
  render(); void controller.start();
}

if (typeof window !== 'undefined' && !globalThis.__UPDATES_TEST__) mountUpdates();
