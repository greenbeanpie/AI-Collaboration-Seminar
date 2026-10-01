/* global window, document, CustomEvent */
// The update shell remains usable before React loads (including recoverable asset failures).
// Prefer the application's existing accessible Modal; otherwise render a page-local dialog.
let fallbackActive = false;
export function requestPageDialog(options) {
  return new Promise(resolve => {
    const request = new CustomEvent('app-page-dialog', { cancelable: true, detail: { options, resolve } });
    if (!window.dispatchEvent(request)) return;
    const cancelled = options.kind === 'prompt' ? null : false;
    if (fallbackActive) { resolve(cancelled); return; }
    fallbackActive = true;
    let settled = false;
    let previous = document.activeElement;
    while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
    const wrapper = document.createElement('div');
    wrapper.className = 'standalone-page-dialog';
    const backdrop = document.createElement('div');
    const panel = document.createElement('section'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.tabIndex = -1;
    const title = document.createElement('h2'); title.textContent = options.title || (options.kind === 'prompt' ? '输入内容' : '确认操作'); panel.setAttribute('aria-label', title.textContent);
    const message = document.createElement('p'); message.textContent = options.message;
    const form = document.createElement('form'); const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const input = options.kind === 'prompt' ? document.createElement('input') : null;
    if (input) { input.value = options.initialValue || ''; input.setAttribute('aria-label', '输入内容'); }
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = options.cancelLabel || '取消';
    const accept = document.createElement('button'); accept.type = 'submit'; accept.textContent = options.confirmLabel || '确定'; accept.className = 'primary';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.className = 'dialog-close'; close.setAttribute('aria-label', '关闭');
    const style = document.createElement('style'); style.textContent = '.standalone-page-dialog{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;font:14px/1.6 system-ui;color:#202b3c}.standalone-page-dialog>div{position:absolute;inset:0;background:#0007}.standalone-page-dialog section{position:relative;box-sizing:border-box;width:min(460px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid #ccd2de;border-radius:14px;background:#fff;box-shadow:0 18px 60px #0004}.standalone-page-dialog h2{font-size:19px;margin:0 32px 16px 0}.standalone-page-dialog p{white-space:pre-wrap;overflow-wrap:anywhere}.standalone-page-dialog input{box-sizing:border-box;width:100%;font:inherit;padding:9px;border:1px solid #8896a8;border-radius:7px}.standalone-page-dialog button{font:inherit;border:1px solid #abb5c4;border-radius:7px;background:#fff;padding:7px 16px;cursor:pointer}.standalone-page-dialog .primary{background:#2359a5;color:#fff}.standalone-page-dialog .dialog-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}.standalone-page-dialog .dialog-close{position:absolute;right:16px;top:12px;padding:3px 10px}.standalone-page-dialog :focus-visible{outline:3px solid #5b9bdf;outline-offset:2px}@media(prefers-color-scheme:dark){.standalone-page-dialog{color:#ecf1f9}.standalone-page-dialog section,.standalone-page-dialog button,.standalone-page-dialog input{background:#202936;color:inherit;border-color:#60728a}.standalone-page-dialog .primary{background:#2359a5}}';
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const finish = result => {
      if (settled) return; settled = true;
      window.removeEventListener('popstate', dismiss); window.removeEventListener('pagehide', dismiss); document.removeEventListener('keydown', keys);
      wrapper.remove(); document.body.style.overflow = overflow; fallbackActive = false;
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
      resolve(result);
    };
    const dismiss = () => finish(cancelled);
    const keys = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key !== 'Tab') return;
      const controls = [...panel.querySelectorAll('button,input')]; const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    close.onclick = dismiss; cancel.onclick = dismiss; backdrop.onclick = dismiss;
    form.onsubmit = event => { event.preventDefault(); finish(input ? input.value : true); };
    panel.append(close, title); form.append(message); if (input) form.append(input);
    if (options.kind !== 'alert') actions.append(cancel); actions.append(accept); form.append(actions); panel.append(form);
    wrapper.append(style, backdrop, panel); document.body.append(wrapper);
    window.addEventListener('popstate', dismiss); window.addEventListener('pagehide', dismiss); document.addEventListener('keydown', keys);
    (input || (options.kind === 'alert' ? accept : cancel)).focus(); input?.select();
  });
}
export function confirmInPage(message) { return requestPageDialog({ kind: 'confirm', message }).then(result => result === true); }
