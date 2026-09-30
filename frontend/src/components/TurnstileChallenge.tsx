import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render(element: HTMLElement, options: { sitekey: string; action: string; theme: 'auto'; callback: (token: string) => void; 'expired-callback': () => void; 'timeout-callback': () => void; 'error-callback': (code: string) => void }): string;
  remove(id: string): void;
};
declare global { interface Window { turnstile?: TurnstileApi } }
let loading: Promise<void> | undefined;
function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => { if (window.turnstile) resolve(); else { script.remove(); loading = undefined; reject(new Error('验证组件未就绪')); } };
    script.onerror = () => { script.remove(); loading = undefined; reject(new Error('无法加载安全验证，请检查网络')); };
    document.head.appendChild(script);
  });
  return loading;
}
export function TurnstileChallenge({ siteKey, reset, onToken, onError }: { siteKey: string; reset: number; onToken: (token: string) => void; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let widget: string | undefined;
    void load().then(() => {
      if (cancelled || !container.current || !window.turnstile) return;
      widget = window.turnstile.render(container.current, {
        sitekey: siteKey, action: 'email_login', theme: 'auto', callback: onToken,
        'expired-callback': () => { onToken(''); onError('安全验证已过期，请重新验证'); },
        'timeout-callback': () => { onToken(''); onError('安全验证超时，请重试；若仍失败，请检查浏览器与网络'); },
        'error-callback': (code: string) => { onToken(''); const visibleCode = /^\d+$/.test(code) ? `（${code}）` : ''; onError(`安全验证失败${visibleCode}，请重试或使用系统浏览器`); },
      });
    }).catch(error => { if (!cancelled) onError(error instanceof Error ? error.message : '安全验证不可用'); });
    return () => { cancelled = true; if (widget && window.turnstile) window.turnstile.remove(widget); };
  }, [siteKey, reset, onToken, onError]);
  return <div aria-label="验证码发送安全验证" ref={container} />;
}
