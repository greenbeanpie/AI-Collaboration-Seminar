# Notifications

Apply additive D1 migration `0018_notifications.sql` before publishing this backend. It creates notification history, per-user read/dismiss receipts, settings, device subscriptions and a push outbox. Existing business records are not backfilled or deleted.

All routes use the standard `{ data, requestId }` envelope and require a current password session:

- `GET /api/v1/notifications?cursor=&limit=50`: visible history, including dismissed entries, with `nextCursor` and `unreadCount` (read/dismissed entries excluded from the count)
- `POST /api/v1/notifications/{id}/read` and `/dismiss`: idempotent per-user receipts
- `GET/PUT /api/v1/notifications/settings`: `{ inAppEnabled, pushEnabled }`, both default to true; in-app preference controls presentation, while history remains available
- `GET /api/v1/notifications/push/status`: `{ configured, publicKey }`; missing configuration returns `false` and an empty public key
- `POST /api/v1/notifications/push/subscriptions`: `{ endpoint, keys: { p256dh, auth } }` → `{ id }`
- `POST /api/v1/notifications/push/lookup`: `{ endpoint }` → own `{ id }` or `{ id: null }`
- `DELETE /api/v1/notifications/push/subscriptions/{id}`: recoverably disables the owned subscription

Logout accepts the optional `X-Push-Subscription-Id` header. It disables that subscription only when both its account and session match. Dispatch also refuses expired or revoked sessions, so omitted headers cannot keep logged-out session delivery active. Other devices remain registered.

Source additions, completed requirement extraction, requirement confirmation/edits, and support replies/status changes create durable generic events in the same D1 transaction as their business changes. Events do not contain source text, requirement titles, ticket titles or replies. Project events go only to members present at creation. Ticket events go to the owner/current staff, excluding the actor. Current visibility is checked again on history/read/dismiss and before each push. Newly joined members/devices do not receive old queued pushes.

System push is optional. The deployment owner must supply `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` via the approved credential setup; this change neither generates nor configures credentials. `VAPID_SUBJECT` may supply a valid `mailto:` or HTTPS contact; otherwise the first HTTPS `ALLOWED_ORIGINS` entry is used. Without configuration, new system subscriptions are rejected and no push is queued or sent; in-app history works normally.

The existing cron dispatches bounded batches. Delivery uses RFC 8291 `aes128gcm` and RFC 8292 VAPID; the public RFC encryption vector is tested. Requests only target approved HTTPS browser push providers and never follow redirects. Outbox records deduplicate event/device pairs, use leases and bounded retries, and expire after 24 hours. Provider 404/410 responses disable endpoints without deleting subscription history; the same owner can re-register. Network ambiguity can still cause delivery retries; stable notification IDs/Topic plus the service worker's account check and notification tag prevent stale-account display and visible duplication.
