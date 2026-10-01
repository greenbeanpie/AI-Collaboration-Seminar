# Notifications

Apply additive D1 migration `0019_notifications.sql` before publishing this backend. It creates notification history, per-user read/dismiss receipts, settings, device subscriptions and a push outbox. Existing business records are not backfilled or deleted.

All routes use the standard `{ data, requestId }` envelope and require a current password session:

- `GET /api/v1/notifications?cursor=&limit=50`: visible history, including dismissed entries, with `nextCursor` and `unreadCount` (read/dismissed entries excluded from the count)
- `POST /api/v1/notifications/{id}/read` and `/dismiss`: idempotent per-user receipts
- `GET/PUT /api/v1/notifications/settings`: `{ inAppEnabled, pushEnabled }`, both default to true; PUT accepts one or both fields and preserves omitted fields atomically; in-app preference controls presentation, while history remains available
- `GET /api/v1/notifications/push/status`: `{ configured, publicKey }`; missing configuration returns `false` and an empty public key
- `POST /api/v1/notifications/push/subscriptions`: `{ endpoint, keys: { p256dh, auth } }` → `{ id }`
- `POST /api/v1/notifications/push/lookup`: `{ endpoint }` → own active `{ id }` or `{ id: null }` (revoked/expired subscriptions are not reported as active)
- `DELETE /api/v1/notifications/push/subscriptions/{id}`: recoverably disables the owned subscription

Notification mutations accept an optional `X-Notification-Account` header. A mismatch with the current authenticated user returns 409 before any state change, preventing delayed actions started under a different account. Logout honors the same guard. Requests without the header remain compatible.

Logout accepts the optional `X-Push-Subscription-Id` header. It disables that subscription only when both its account and session match. Dispatch also refuses expired or revoked sessions, so omitted headers cannot keep logged-out session delivery active. Other devices remain registered.

Source additions, completed requirement extraction, requirement confirmation/edits, and support replies/status changes create durable generic events in the same D1 transaction as their business changes. Events do not contain source text, requirement titles, ticket titles or replies. Project events go only to members present at creation. Ticket events go to the owner/current staff, excluding the actor. Current visibility is checked again on history/read/dismiss and before each push. Newly joined members/devices do not receive old queued pushes.

System push is optional. The deployment owner must supply `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` via the approved credential setup; this change neither generates nor configures credentials. `VAPID_SUBJECT` may supply a valid `mailto:` or HTTPS contact; otherwise the first HTTPS `ALLOWED_ORIGINS` entry is used. Without configuration, new system subscriptions are rejected and no push is queued or sent; in-app history works normally.

The existing cron dispatches bounded batches. Delivery uses RFC 8291 `aes128gcm` and RFC 8292 VAPID; the public RFC encryption vector is tested. Requests only target approved HTTPS browser push providers and never follow redirects. Outbox records deduplicate event/device pairs, use leases and bounded retries, and expire after 24 hours. Provider 404/410 responses disable endpoints without deleting subscription history; the same owner can re-register. Network ambiguity can still cause delivery retries; stable notification IDs/Topic plus the service worker's account check and notification tag prevent stale-account display and visible duplication.

## Client settings and platform acceptance

Settings has separate installation and notification tabs. The first configured, authenticated startup explains system notifications; only an explicit click calls `Notification.requestPermission()`. Denied/default permission never silently becomes a subscription; dismissal is remembered per account. Browser subscription payloads contain only endpoint and keys. Installation reuses the existing one-use prompt, and installing does not automatically authorize notifications.

The client silently hydrates existing server history, then coalesces new IDs into one top toast. It polls only while visible/online, reconnects on foreground/network recovery, supports read/dismiss receipts and older-history pagination, and does not replay old history as toast after refresh. Lock-screen notifications use a generic summary without source/ticket/profile bodies. Service Worker click handling permits only same-origin app paths and delegates open-page navigation to the normal unsaved-edit guard. A device owner ID is acknowledged and stored separately from user content; messages for a previous account are suppressed. Logout revokes the current device before browser unsubscribe and session deletion, with an expected-account guard for interrupted actions.

Official platform guidance: [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [permission user gesture](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static), [WebKit iOS/iPadOS support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). iOS/iPadOS 16.4+ requires a Home Screen web app. Delivery when closed depends on browser/OS background support, network, focus and battery restrictions; it is not an unconditional real-time guarantee. Without VAPID setup, client settings explicitly report background system push unavailable, while in-app/history work.

## Owner-only VAPID setup

`node backend/scripts/prepare-vapid.mjs --plan` only prints the setup plan. It creates no credentials or files and makes no network requests. The owner may explicitly run its documented `--generate --output <new-private-directory>` mode. This writes a separate application's P-256 public key and private scalar to a newly created local directory without printing or uploading the private value. The helper refuses to overwrite a directory or key file.

The owner then enters the two file values as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on the existing production backend Worker `greenbp-team-office-backend`. The private value must be entered and submitted by the owner in Cloudflare's secure interface; never paste it into chat or tickets or commit/upload the files. `VAPID_PRIVATE_KEY` is the base64url 32-byte scalar, not the older P1 base64url JWK format. An optional `VAPID_SUBJECT` is an owner contact HTTPS URL or mailto; without it the existing allowed production origin is used. Keep the private directory outside the repository. This implementation has not run generation or configured either secret.
