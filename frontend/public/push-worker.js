/* Standard Web Push receiver. Persist only the current account's opaque ID. */
const PUSH_FALLBACK = '/app/settings/notifications';
function pushPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || (value.includes('\\') || [...value].some(character => character.charCodeAt(0) <= 32))) return PUSH_FALLBACK;
  try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin && !url.pathname.startsWith('/api/') ? url.pathname + url.search + url.hash : PUSH_FALLBACK; }
  catch { return PUSH_FALLBACK; }
}
function ownerStore(value, write = false) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('app-push-device', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('state'); };
    open.onerror = () => reject(new Error('push-state-unavailable'));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('state', write ? 'readwrite' : 'readonly');
      const request = write ? transaction.objectStore('state').put(value, 'account') : transaction.objectStore('state').get('account');
      let result = null;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => { database.close(); resolve(result ?? null); };
      transaction.onerror = () => { database.close(); reject(new Error('push-state-unavailable')); };
      transaction.onabort = transaction.onerror;
    };
  });
}
async function receivePush(event, readOwner = () => ownerStore()) {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  const data = payload?.data;
  if (!data || typeof data.userId !== 'string' || typeof data.notificationId !== 'string') return;
  let owner;
  try { owner = await readOwner(); } catch { return; }
  if (!owner || data.userId !== owner) return;
  // Lock-screen text deliberately excludes project, request, ticket or profile content.
  await self.registration.showNotification('应用有新的更新', { body: '请打开应用查看通知。', tag: `notice:${data.notificationId}`, data: { userId: owner, notificationId: data.notificationId, url: pushPath(data.url) } });
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) if (new URL(client.url).origin === self.location.origin) client.postMessage({ type: 'APP_PUSH_RECEIVED', userId: owner, notificationId: data.notificationId });
}
async function clickPush(event, readOwner = () => ownerStore()) {
  event.notification.close();
  const data = event.notification.data;
  const owner = await readOwner().catch(() => null);
  if (!owner || owner !== data?.userId) return;
  const url = pushPath(data.url);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = clients.find(item => new URL(item.url).origin === self.location.origin);
  if (client) { client.postMessage({ type: 'APP_PUSH_OPEN', userId: owner, notificationId: data.notificationId, url }); await client.focus(); }
  else await self.clients.openWindow(url);
}
self.addEventListener('message', event => {
  if (event.data?.type !== 'PUSH_ACCOUNT') return;
  const source = event.source;
  if (!source || !('url' in source) || new URL(source.url).origin !== self.location.origin) return;
  const value = event.data.userId;
  if (value !== null && (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value))) return;
  event.waitUntil(ownerStore(value, true).then(() => event.ports[0]?.postMessage({ ok: true }), () => event.ports[0]?.postMessage({ ok: false })));
});
self.addEventListener('push', event => event.waitUntil(receivePush(event)));
self.addEventListener('notificationclick', event => event.waitUntil(clickPush(event)));
if (globalThis.__PUSH_TEST__) globalThis.__pushFunctions = { pushPath, receivePush, clickPush };
