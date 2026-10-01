# Update compatibility and recovery

This change addresses independent-review findings F1 (old tabs losing lazy chunks) and F3 (an unconsumed installation opportunity disappearing from notification history).

Before the new Workbox worker activates and prunes its old precache manifest, `public/asset-compat.js` copies only same-origin generated `/assets/*-hash.js` and CSS responses from Workbox precaches into a dedicated static compatibility cache. The new worker serves old hashed asset URLs from that cache when they are absent from its current manifest. This supports clients that have not confirmed their own reload, including upgrades from the reviewed c3f5e98 worker. No API, HTML, document, account or user-cache contents are copied. The compatibility cache is limited to 256 entries/seven days; asset expiration or network failure still has an explicit recovery path.

All authenticated lazy routes use `resilientLazy`. Recognized JS/CSS load failures resolve to a local recovery page inside the existing app instead of replacing the entire router with an exception screen. Programming errors retain normal error behavior. The page never auto-reloads. Its update button, header and notification-history actions share the same save-edits confirmation. An unavailable resource with no downloadable update uses an honest `refresh` state; it does not claim that a new version was downloaded. Offline checks remain offline and cancellation does not reload.

The native install state emits a safe boolean availability event and answers status requests. Notification scope changes reconstruct the current installation action only while the native opportunity is still unconsumed. This restores the action across project/account/guest scope switches and dashboard remounts without replaying the one-time install toast. Consuming the prompt or installing removes the action; a history action never invokes the browser prompt automatically.

Verification:

- Unit tests cover static-only copying, local fallback with existing shell edits retained, honest refresh confirmation/cancellation/deduplication, and install-state restoration without prompting.
- `frontend/e2e/update-compat.mjs` upgrades a separately built immutable c3f5e98 client to the fixed generated worker while replacing every V2 JS/CSS URL and returning 404 for old server URLs. Actual two-tab nickname drafts survive unsolicited activation and canceled update/navigation; an unloaded old AI route remains usable from preserved assets. A separate user-data cache is unchanged.
- The same browser script deliberately evicts the old AI asset to exercise local recovery, cancellation and explicit reload; it also verifies same-version temporary resource failure with SW registration blocked. Native install events are synthetic, and no OS installation occurs.
- The standard SW/offline/repeated-operation and integrated settings/profile/unified-AI browser regressions also run against the final production build. All API accounts and writes are local synthetic fixtures; real providers, production headers, Safari/Firefox and real-device installation are outside this local validation.
