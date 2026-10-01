import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationRequest } from './api';
import { NotificationFeed, subscriptionPayload, notifyWorkerAccount, safeNotificationUrl, notificationPermission, subscribeDevice, type DeliverySettings, type NotificationPage, type PushStatus } from './core';

export function NotificationRuntime({ userId, enabled = true, settingsUrl }: { userId: string | null; enabled?: boolean; settingsUrl: string }) {
  const navigate = useNavigate();
  const [offer, setOffer] = useState(false);
  const [configured, setConfigured] = useState<PushStatus | null>(null);
  const [message, setMessage] = useState('');
  const permissionBusy = useRef(false);
  useEffect(() => {
    if (!userId || !enabled) return;
    const feed = new NotificationFeed();
    let active = true, loading = false;
    const abort = new AbortController();
    let settings: DeliverySettings = { inAppEnabled: true, pushEnabled: true };
    const onboardingKey = `app-push-introduction:${userId}`;
    const sync = async () => {
      if (!active || loading || !navigator.onLine || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const [page, preferences] = await Promise.all([
          notificationRequest<NotificationPage>('/notifications?limit=50', 'GET', undefined, abort.signal),
          notificationRequest<DeliverySettings>('/notifications/settings', 'GET', undefined, abort.signal),
        ]);
        if (!active) return;
        settings = preferences;
        const fresh = feed.accept(page.items);
        window.dispatchEvent(new CustomEvent('app-notification-inbox', { detail: { items: page.items, unreadCount: page.unreadCount, url: settingsUrl } }));
        if (settings.inAppEnabled && fresh.length) window.dispatchEvent(new CustomEvent('app-notification', { detail: { id: 'inbox-new', text: fresh.length === 1 ? '收到新的更新，可在通知中心查看。' : `收到 ${fresh.length} 条新更新，可在通知中心查看。`, action: 'inbox' } }));
      } catch { /* Disconnected/auth errors are retried on reconnect; never replay history as toast. */ }
      finally { loading = false; }
    };
    const refresh = () => { void sync(); };
    const modify = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; action: 'read' | 'dismiss' }>).detail;
      if (!detail || !/^[a-zA-Z0-9-]{1,80}$/.test(detail.id) || !['read', 'dismiss'].includes(detail.action)) return;
      void notificationRequest(`/notifications/${encodeURIComponent(detail.id)}/${detail.action}`, 'POST', {}, undefined, userId).then(refresh).catch(() => window.dispatchEvent(new CustomEvent('app-notification', { detail: { kind: 'error', text: '通知状态未能保存，请重试。' } })));
    };
    const open = (event: Event) => {
      const url = safeNotificationUrl((event as CustomEvent<{ url: string }>).detail?.url, settingsUrl);
      navigate(url);
    };
    const received = (event: MessageEvent) => {
      if (event.data?.userId !== userId) return;
      if (event.data.type === 'APP_PUSH_RECEIVED') refresh();
      if (event.data.type === 'APP_PUSH_OPEN') { navigate(safeNotificationUrl(event.data.url, settingsUrl)); refresh(); }
    };
    const intro = async () => {
      try {
        const [status, preferences] = await Promise.all([notificationRequest<PushStatus>('/notifications/push/status', 'GET', undefined, abort.signal), notificationRequest<DeliverySettings>('/notifications/settings', 'GET', undefined, abort.signal)]);
        if (!active) return;
        setConfigured(status);
        let alreadyShown = false;
        try { alreadyShown = localStorage.getItem(onboardingKey) === '1'; } catch { /* No persistent storage: current mount still respects dismissal. */ }
        setOffer(preferences.pushEnabled && status.configured && notificationPermission() === 'default' && !alreadyShown);
        await notifyWorkerAccount(userId);
        // Rebind only an already-consented subscription owned by this account.
        // Never silently create a new browser subscription or request permission.
        if (preferences.pushEnabled && status.configured && notificationPermission() === 'granted') {
          const registration = await navigator.serviceWorker.getRegistration('/');
          const subscription = await registration?.pushManager?.getSubscription();
          if (subscription) {
            const owned = await notificationRequest<{id:string|null}>('/notifications/push/lookup','POST',{endpoint:subscription.endpoint},abort.signal);
            if (owned.id && active) await notificationRequest('/notifications/push/subscriptions','POST',subscriptionPayload(subscription),abort.signal,userId);
          }
        }
      } catch { /* Settings exposes an explicit retry. */ }
    };
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    window.addEventListener('app-notification-scope', refresh); window.addEventListener('app-notification-settings-changed', refresh);
    window.addEventListener('app-notification-state', modify); window.addEventListener('app-notification-open', open);
    navigator.serviceWorker?.addEventListener('message', received);
    const interval = window.setInterval(refresh, 30_000);
    void sync(); void intro();
    return () => {
      active = false; abort.abort(); window.clearInterval(interval);
      window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('app-notification-scope', refresh); window.removeEventListener('app-notification-settings-changed', refresh);
      window.removeEventListener('app-notification-state', modify); window.removeEventListener('app-notification-open', open);
      navigator.serviceWorker?.removeEventListener('message', received);
      window.dispatchEvent(new CustomEvent('app-notification-inbox', { detail: { items: [], url: settingsUrl } }));
    };
  }, [userId, enabled, settingsUrl, navigate]);

  function dismissOffer() {
    if (userId) try { localStorage.setItem(`app-push-introduction:${userId}`, '1'); } catch { /* Current render still closes. */ }
    setOffer(false);
  }
  async function allow() {
    if (permissionBusy.current || !configured?.configured || !userId) return;
    permissionBusy.current = true; setMessage('');
    try {
      // Call synchronously in the click gesture, before any network await.
      const permission = await Notification.requestPermission();
      dismissOffer();
      if (permission === 'granted') { await subscribeDevice(userId, configured.publicKey, notificationRequest); setMessage('当前设备已开启系统通知。'); }
      else setMessage('通知权限未开启，可在设置中查看开启方法。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '设备通知未能开启，可在设置中重试。'); }
    finally { permissionBusy.current = false; }
  }
  if (!userId || !enabled) return null;
  return <>{offer && <section className="notification-introduction" aria-label="开启通知"><div><strong>及时收到项目和工单更新</strong><p>应用内通知默认开启。允许系统通知后，本设备会显示不含正文的更新摘要；浏览器和系统可能限制后台送达。</p></div><div className="notification-buttons"><button type="button" onClick={() => void allow()}>允许系统通知</button><button type="button" onClick={dismissOffer}>稍后</button></div></section>}{message && <p className="notification-feedback" role="status">{message}</p>}</>;
}
