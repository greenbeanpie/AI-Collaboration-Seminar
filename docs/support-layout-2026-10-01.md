# Reported project navigation and date-input layout fixes

Scope: support tickets `c6c73d0e-4089-407c-86ff-eb4edcc0ad8d` (header alignment) and `32a8dc0a-ecc8-448e-aa20-5c995d0671f3` (deadline control overflow), against baseline `cf6fb08`.

## Changes

- The project-function links were rendered by `ProjectShell` below the project title, independently of the account header. Move that navigation into the flexible area of `AppShell` so the project controls and account actions share one header row.
- Wider layouts retain all 12 project links in an independently scrollable region. At 790px and narrower, a labeled native selector retains every destination and current-route state. It does not turn a wide unwrappable tab strip into page overflow.
- Compact layouts keep the profile shortcut and an explicit account-actions button in the same row. Theme selection, support and logout remain in a bounded panel, with Escape/focus restoration, outside-pointer and route-change dismissal. Desktop actions remain directly visible. Existing global navigation and the sidebar brand are preserved.
- Constrain shared native date/datetime-local inputs and their wrappers to their parent width, including intrinsic minimum width. Use zero-minimum grid tracks in date fields, settings forms and cards containing date controls. Keep native picker behavior, values, read-only/disabled states and focus rings; no clipping, automatic date defaults, data writes or date-semantic changes.

## Verification

- Frontend: 39 files / 194 tests passed, including route switching/Back, nested-route selection, menu dismissal and theme/logout guards; existing date and guest-date behavior tests passed.
- Frontend TypeScript, ESLint, production build and Worker forwarding verification passed.
- `scripts/verify-ticket-layout-ui.cjs` adds loopback-only synthetic browser checks for 320, 375, 390, 560, 768, 790, 791, 1024 and 1440px: header co-location, date bounds, page overflow, keyboard/menu/navigation and no API writes. Syntax checked.
- Actual browser measurements and screenshots remain unverified in this cloud executor: system Chromium fails with `socket() failed: Operation not permitted`, and the managed cloud browser rejects the local test URL with `ERR_BLOCKED_BY_CLIENT`. Component/CSS tests are not a substitute for real-device Safari or rendered pixel validation. The deadline overflow report is addressed through its full input/wrapper/grid sizing chain, but a specific device reproduction is not claimed.

No backend, AI settings, provider calls or production project content is changed. Notification development owns its separate App integration and later logout cleanup; this patch owns header JSX/CSS.

## Owner-directed navigation placement rollback

The owner's subsequent screenshot showed that putting project links beside the account controls produced an unnecessarily crowded header and a visible horizontal scrollbar. The latest explicit owner request supersedes the earlier ticket's one-row placement request.

This increment moves only project navigation back into `ProjectShell`, between the project banner and content. Desktop project labels wrap within the content width rather than scrolling horizontally; the compact selector retains all 12 destinations below the title. Account/avatar/theme behavior, notification/update icons, logout subscription cleanup and the separate native-date containment repair remain intact. It is not a wholesale revert of `e189de2`.

Regression coverage checks the structural separation from the account header, every link and compact-selector destination, active-route state, Back and nested routes. Rendered device/browser validation remains subject to the previously documented cloud runtime limitation; no screenshot-based success is asserted. The original header ticket was reopened with a clear explanation of the owner's updated direction.
