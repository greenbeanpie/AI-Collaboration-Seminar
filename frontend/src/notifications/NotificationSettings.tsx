import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationRequest } from './api';
import { mergeNotificationPage, notificationPermission, safeNotificationUrl, subscribeDevice, unsubscribeDevice, type DeliverySettings, type NotificationItem, type NotificationPage, type PushStatus } from './core';

export function NotificationSettings({ userId, enabled = true }: { userId: string; enabled?: boolean }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<DeliverySettings | null>(null);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [permission, setPermission] = useState(notificationPermission);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const loadedEarlier = useRef(false);
  const historyGeneration=useRef({value:0});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const historyVersion=historyGeneration.current;
    const abort = new AbortController();
    let snapshotGeneration=0,loading=false,again=false;
    const applyPage=(page:NotificationPage)=>{
      setItems(previous=>mergeNotificationPage(previous,page,loadedEarlier.current));
      if(!loadedEarlier.current || !page.nextCursor)setCursor(page.nextCursor);
    };
    const receiveSnapshot=(event:Event)=>{
      const detail=(event as CustomEvent<NotificationPage & {userId:string;resetHistory?:boolean}>).detail;
      if(!active || detail?.userId!==userId || !Array.isArray(detail.items))return;
      if(detail.resetHistory){loadedEarlier.current=false;historyVersion.value++;}
      snapshotGeneration++;applyPage(detail);
    };
    const load = async () => {
      if(loading){again=true;return;}loading=true;
      const generation=snapshotGeneration;
      try {
        const [preferences, push, page] = await Promise.all([
          notificationRequest<DeliverySettings>('/notifications/settings', 'GET', undefined, abort.signal),
          notificationRequest<PushStatus>('/notifications/push/status', 'GET', undefined, abort.signal),
          notificationRequest<NotificationPage>('/notifications?limit=50', 'GET', undefined, abort.signal),
        ]);
        if (!active) return;
        setSettings(preferences); setStatus(push); if(generation===snapshotGeneration)applyPage(page);
        const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
        const subscription = await registration?.pushManager?.getSubscription();
        if (subscription) {
          const owned = await notificationRequest<{ id: string | null }>('/notifications/push/lookup', 'POST', { endpoint: subscription.endpoint }, abort.signal);
          if (active) setSubscribed(Boolean(owned.id));
        }
        if (active) setPermission(notificationPermission());
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : '通知设置加载失败，请刷新重试。'); }
      finally {loading=false;if(active&&again){again=false;void load();}}
    };
    const refresh=(event:Event)=>{
      const account=(event as CustomEvent<{userId?:string}>).detail?.userId;
      if(!account || account===userId)void load();
    };
    window.addEventListener('app-notification-inbox',receiveSnapshot);
    window.addEventListener('app-notification-refresh',refresh);
    void load();
    return () => { active = false;historyVersion.value++;abort.abort();window.removeEventListener('app-notification-inbox',receiveSnapshot);window.removeEventListener('app-notification-refresh',refresh); };
  }, [userId, enabled]);

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作未完成，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  }
  function save(field: keyof DeliverySettings, value: boolean) {
    void run(async () => {
      const saved = await notificationRequest<DeliverySettings>('/notifications/settings', 'PUT', { [field]: value }, undefined, userId);
      setSettings(saved); setMessage('通知设置已保存。');
      window.dispatchEvent(new Event('app-notification-settings-changed'));
    });
  }
  function enablePush() {
    if (lock.current || !status?.configured || permission === 'unsupported' || permission === 'denied') return;
    // Start the permission request inside this click before awaiting HTTP or SW.
    const requested = permission === 'granted' ? Promise.resolve('granted' as const) : Notification.requestPermission();
    void run(async () => {
      const granted = await requested; setPermission(granted);
      try { localStorage.setItem(`app-push-introduction:${userId}`, '1'); } catch { /* Browser permission itself remains authoritative. */ }
      if (granted !== 'granted') { setMessage('未获得系统通知权限。应用内通知仍可使用。'); return; }
      await subscribeDevice(userId, status.publicKey, notificationRequest);
      setSubscribed(true); setMessage('当前设备已订阅系统通知。');
    });
  }
  function changeState(id: string, action: 'read' | 'dismiss') {
    void run(async () => {
      await notificationRequest(`/notifications/${encodeURIComponent(id)}/${action}`, 'POST', {}, undefined, userId);
      const page = await notificationRequest<NotificationPage>('/notifications?limit=50');
      setItems(previous=>mergeNotificationPage(previous,page,loadedEarlier.current)); if(!loadedEarlier.current || !page.nextCursor)setCursor(page.nextCursor);
      window.dispatchEvent(new Event('app-notification-settings-changed'));
      setMessage(action === 'read' ? '已标记为已读。' : '已收起，历史记录仍保留。');
    });
  }
  if (!enabled) return <section className="delivery-card"><h2>推送通知</h2><p>演示和游客身份不注册系统推送。可使用应用内演示提醒；真实账户登录后可设置当前设备。</p></section>;
  return <div className="delivery-settings">
    <section className="delivery-card"><h2>通知方式</h2><p>通知中心保留要求变更、工单回复和提醒。更改投递方式不会删除历史。</p>
      <label className="delivery-toggle"><input type="checkbox" disabled={busy || !settings} checked={settings?.inAppEnabled ?? true} onChange={event => save('inAppEnabled', event.target.checked)}/><span><strong>网页顶部提醒</strong><small>应用内默认开启；打开页面时定时补拉，网络恢复后自动补拉，不重复弹出旧通知。</small></span></label>
      <label className="delivery-toggle"><input type="checkbox" disabled={busy || !settings} checked={settings?.pushEnabled ?? true} onChange={event => save('pushEnabled', event.target.checked)}/><span><strong>系统推送</strong><small>账户投递偏好默认开启；仍需本设备单独授权和订阅，其他设备互不影响。</small></span></label>
    </section>
    <section className="delivery-card"><h2>当前设备的系统通知</h2>
      <p>浏览器权限：{permission === 'granted' ? '已允许' : permission === 'denied' ? '已拒绝' : permission === 'unsupported' ? '当前环境不支持' : '尚未选择'} · 设备订阅：{subscribed ? '已订阅' : '未订阅'}</p>
      {status?.configured === false && <p role="status">后台推送尚未配置。网页提醒和通知历史可正常使用，关闭网页后的系统推送暂不可用。</p>}
      {permission === 'denied' && <p>已尊重你的拒绝，不会再次弹出授权。若想开启，请在浏览器的网站权限或系统通知设置中允许本站，然后刷新此页。</p>}
      <div className="notification-buttons"><button type="button" disabled={busy || !status?.configured || permission === 'unsupported' || permission === 'denied' || subscribed || !settings?.pushEnabled} onClick={enablePush}>允许并订阅当前设备</button>
      {subscribed && <button type="button" disabled={busy} onClick={() => void run(async () => { await unsubscribeDevice(userId, notificationRequest); setSubscribed(false); setMessage('当前设备已取消系统推送，历史记录仍保留。'); })}>取消当前设备订阅</button>}</div>
      <p className="delivery-help">需要 HTTPS 和支持 Web Push 的浏览器。iPhone/iPad 通常需 iOS/iPadOS 16.4 或更高，并先添加到主屏幕。浏览器关闭、系统节电或专注模式可能限制送达；不能保证每个平台实时收到。</p>
      <p className="delivery-help">系统通知只显示更新摘要，不显示要求、工单或资料正文。退出登录会取消当前设备订阅。</p>
    </section>
    {message && <p role="status" className="notification-feedback">{message}</p>}
    <section className="delivery-card"><h2>通知历史</h2>{!items.length && <p>暂无通知。</p>}
      {items.map(item => <article className="delivery-entry" key={item.id}><div><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.dismissedAt ? '已收起' : item.readAt ? '已读' : '未读'}</small></div><p>{item.body}</p><div className="notification-buttons"><button type="button" onClick={() => navigate(safeNotificationUrl(item.url, './'))}>查看相关内容</button>{!item.readAt && <button type="button" disabled={busy} onClick={() => changeState(item.id, 'read')}>标记已读</button>}{!item.dismissedAt && <button type="button" disabled={busy} onClick={() => changeState(item.id, 'dismiss')}>收起提醒</button>}</div></article>)}
      {cursor && <button type="button" disabled={busy} onClick={() => void run(async () => { const generation=historyGeneration.current.value;loadedEarlier.current=true;const page=await notificationRequest<NotificationPage>(`/notifications?limit=50&cursor=${encodeURIComponent(cursor)}`);if(generation!==historyGeneration.current.value)return;setItems(previous=>[...previous,...page.items.filter(item=>!previous.some(old=>old.id===item.id))]);setCursor(page.nextCursor); })}>加载更早通知</button>}
    </section>
  </div>;
}
