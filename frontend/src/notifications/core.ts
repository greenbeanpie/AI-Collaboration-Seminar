export type NotificationItem = { id: string; kind: string; title: string; body: string; url: string; createdAt: string; readAt: string | null; dismissedAt: string | null };
export type NotificationPage = { items: NotificationItem[]; unreadCount: number; nextCursor: string | null };
export type DeliverySettings = { inAppEnabled: boolean; pushEnabled: boolean };
export type PushStatus = { configured: boolean; publicKey: string };
export type NotificationRequest = <T>(path: string, method?: 'GET' | 'PUT' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal, expectedAccount?: string) => Promise<T>;

/** Restrict navigation to this app; server data never becomes an arbitrary link. */
export function safeNotificationUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || (value.includes('\\') || [...value].some(character => character.charCodeAt(0) <= 32))) return fallback;
  const url = new URL(value, 'https://app.invalid');
  return url.origin === 'https://app.invalid' && !url.pathname.startsWith('/api/') ? url.pathname + url.search + url.hash : fallback;
}

/** First fetch hydrates history silently; retries/refreshes never re-toast old IDs. */
export class NotificationFeed {
  private seen = new Set<string>();
  private initialized = false;
  accept(items: NotificationItem[]): NotificationItem[] {
    const fresh = this.initialized ? items.filter(item => !this.seen.has(item.id) && !item.readAt && !item.dismissedAt) : [];
    for (const item of items) this.seen.add(item.id);
    this.initialized = true;
    return fresh;
  }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window ? Notification.permission : 'unsupported';
}

export function deviceKey(userId: string) { return `app-push-device:${userId}`; }
export function deviceSubscriptionId(userId: string): string {
  try { return localStorage.getItem(deviceKey(userId)) ?? ''; } catch { return ''; }
}
export function rememberDevice(userId: string, id: string): void {
  try { if (id) localStorage.setItem(deviceKey(userId), id); else localStorage.removeItem(deviceKey(userId)); } catch { /* Account-scoped lookup still works without storage. */ }
}
export async function notifyWorkerAccount(userId: string | null): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const worker = registration?.active;
  if (!worker) return;
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => { channel.port1.close(); reject(new Error('设备通知状态未能更新，请重试。')); }, 5000);
    channel.port1.onmessage = event => { window.clearTimeout(timer); channel.port1.close(); if (event.data?.ok) resolve(); else reject(new Error('设备通知状态未能更新，请重试。')); };
    worker.postMessage({ type: 'PUSH_ACCOUNT', userId }, [channel.port2]);
  });
  if (userId === null) {
    for (const notice of await registration.getNotifications()) notice.close();
  }
}

export async function unsubscribeDevice(userId: string, request: NotificationRequest): Promise<void> {
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
  const subscription = await registration?.pushManager?.getSubscription();
  let id = deviceSubscriptionId(userId);
  if (!id && subscription) id = (await request<{ id: string | null }>('/notifications/push/lookup', 'POST', { endpoint: subscription.endpoint }, undefined, userId)).id ?? '';
  // Server revoke first: a failed request keeps the account logged in and is retryable.
  if (id) await request(`/notifications/push/subscriptions/${encodeURIComponent(id)}`, 'DELETE', undefined, undefined, userId);
  if (subscription && !await subscription.unsubscribe()) throw new Error('浏览器未能取消当前设备订阅，请重试。');
  rememberDevice(userId, '');
  await notifyWorkerAccount(null).catch(() => undefined);
}

export function subscriptionPayload(subscription: PushSubscription) {
  const value = subscription.toJSON();
  if (!value.keys?.p256dh || !value.keys?.auth) throw new Error('浏览器未返回完整订阅密钥。');
  return {endpoint:subscription.endpoint,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
}
export async function subscribeDevice(userId: string, publicKey: string, request: NotificationRequest): Promise<void> {
  if (notificationPermission() !== 'granted') throw new Error('请先允许浏览器通知。');
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.active || !registration.pushManager) throw new Error('应用后台尚未就绪，请稍后重试。');
  const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4));
  const options = { userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, value => value.charCodeAt(0)) };
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const owned = await request<{ id: string | null }>('/notifications/push/lookup', 'POST', { endpoint: subscription.endpoint }, undefined, userId);
    if (!owned.id) { if (!await subscription.unsubscribe()) throw new Error('无法释放旧账户设备订阅，请重试。'); subscription = null; }
  }
  subscription ??= await registration.pushManager.subscribe(options);
  const result = await request<{ id: string }>('/notifications/push/subscriptions', 'POST', subscriptionPayload(subscription), undefined, userId);
  rememberDevice(userId, result.id);
  await notifyWorkerAccount(userId);
}
