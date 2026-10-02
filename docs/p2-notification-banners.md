# P2 notification banners

Notification summaries now appear as fixed floating cards below the existing toolbar, with rounded corners, a severity icon/label, a close button and the existing relevant action. They do not add page height. Information is blue, success green, warning amber and error red; backgrounds and text adapt to the application's actual light/dark color scheme.

Information/success stay for 5 seconds, warnings 7 seconds and errors 9 seconds, followed by a 180 ms exit animation. Reduced-motion preferences remove the animation. Mouse/pen hover, keyboard focus and a hidden document pause the remaining time independently; touch hover events do not cause a sticky pause. Dismissal and expiry do not change notification read state or remove history/actions.

At most two cards appear on desktop and one at widths up to 600 px. Eight summaries can wait; overflow remains accessible in the existing capped session history. Repeated IDs update progress in place, including during exit. Resizing preserves focused content. Opening notification history clears the floating cards/queue so they cannot overlap the panel; account-scope changes and invalidated installation actions also clean their timers and queued content.

## Validation

- Frontend: 61 files / 339 tests passed with Node 26 and `--no-experimental-webstorage`.
- Typecheck, ESLint, production build, Service Binding verification and production static deployment preflight passed.
- Regression includes severity lifetimes, independent hover/focus pauses, hidden-document pause, touch input, manual close/focus restoration, queue overflow, resize, same-ID exit race, account cleanup, history retention, update confirmation cancellation and installation-action invalidation.
- Connected Chrome tested against a GET-only loopback fixture serving the final production build. Desktop 1440x1000: two 400 px cards, zero added notification height, no horizontal overflow. Phone viewport 390x844: one 366 px card within the viewport, no horizontal overflow. Close buttons measure 44 px. Both actual application themes were checked; browser error logs were empty.
- Local evidence: `/tmp/p2-notification-qa-20261002/{desktop-light,desktop-dark,mobile-light,mobile-dark}.jpg`, `metrics.json`, `/tmp/p2-notification-tests.log`, `/tmp/p2-notification-build.log`. The temporary fixture is outside the build and is not deployable content.
- This is Chrome viewport verification, not a claim of native iOS/Android system-notification or physical-device testing. Existing update-state tests cover activation/reload behavior; the loopback fixture intentionally does not install a service worker.

Reproduce from `frontend`: `npm run typecheck`, `npm run lint`, `npm run build`, and `node --no-experimental-webstorage ./node_modules/vitest/vitest.mjs run`. From the repository root: `node scripts/verify-worker.mjs` and `node scripts/preflight-deploy.mjs production`.

## Publication handoff

Candidate branch: `codex/p2-notification-banners`, based on freshly fetched `origin/main` at `9c3a8f74d37f72f812635a2116868798db1c3f06`. Only the notification script, its tests and this document change. Main, other worktrees, backend business logic, push subscriptions, model configuration and credentials are unchanged. The blocked title patch `9119314` is not part of this candidate.

Main publication and the existing frontend Worker deployment remain coordinated by the parent task's serial publication slot. No production deployment or main push has been performed by this worktree. After the slot is granted, recheck main, fast-forward normally, build, then deploy the existing `greenbp-team-office` Worker with `--env production --keep-vars`, and verify the served notification script/assets.
