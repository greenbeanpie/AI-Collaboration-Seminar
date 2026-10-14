# Auth, invitation and offline recovery browser checks

Use an isolated local database and the local frontend origin. Never point these
fixtures at production. The mail integration tests mock the Resend transport;
`EMAIL_MODE=echo` deliberately returns no token or development code. Browser
checks that use synthetic fragment tokens require records seeded into local D1,
or a local fixture API; they do not establish real email delivery.

## Reusable fixtures

`backend/test/130-recovery-email.test.ts` supplies password accounts, two distinct
sessions, a fetch mock which captures the email body only in test memory,
`createExecutionContext`/`waitOnExecutionContext`, real D1 migrations and real
password hashing. Reuse those factories for an isolated fixture server rather
than adding a public development-token response. The fixture API should use the
same session-cookie/envelope format and these cases:

- unverified registration email, verified recovery email, missing account;
- super-admin, ordinary admin, and ordinary user;
- verification token for user A, expired/consumed token, token invalidated by
  password or email change, plus a second session for user B;
- successful writes with delayed response, hanging response, 403 from a child
  resource followed by root 200, and confirmed root 403/404;
- an existing creation draft whose saved payload differs from the edited UI,
  queued offline operations, and a retained material draft.

Use a controllable local transport to hold a response while leaving its server
write committed. Keep fixture state outside production code and capture no real
credentials. For fragment links use `/email-verify#token=...` or
`/password-reset#token=...`; never put tokens in query strings or server logs.

## Browser matrix

| Scope | Steps | Required observation |
| --- | --- | --- |
| F05 invitation | Open `/app/join?code=...` logged out; register with a separate registration invitation or log in; continue | The same project invitation opens a preview; joining requires explicit confirmation. External/encoded unsafe return destinations fall back to `/app`. |
| F06 email recovery | Open `/help`, follow the primary email recovery link, submit by Enter with missing/unverified/verified identities | All receive the same accepted text. No mailbox address or token is returned. No automatic resend occurs. Admin contact remains a visible fallback. |
| F06 email binding | Sign in, open `/app/settings/security`, enter current password and new recovery email, submit; confirm a synthetic local email fragment under the original account | Old email remains active before confirmation; status changes only after verification. Wrong account, expiry, replay and password/email changes refuse the token. URL fragment is removed from address bar. |
| F06 password reset | Open a valid synthetic local reset fragment, enter matching passwords, submit by Enter; revisit with the same code | All old sessions exit; new password works; second consumption fails. Help and login links remain keyboard reachable. |
| F07 root refusal | Load/cache project data, retain one draft and queued operation, revoke membership locally, refetch the root | Project content disappears immediately; after reload/offline it stays fenced. Draft and blocked operation can be exported; neither automatically syncs. Regrant allows network root refresh but does not silently replay blocked operations. |
| F07 child refusal | Return child 403 while root remains 200, then change root to 403 | The first response does not falsely revoke the whole project; confirmed root refusal fences it. Switching accounts exposes no old drafts/exports. |
| F08 short writes | Hold login/invitation/creation/reset/mail-binding response; cancel or wait 30 seconds; release response after UI changed | Busy state unlocks; wording says result unknown. Unmount/account switch aborts waiting and prevents late success under the new account. Committed registration/creation is checked before repeating. |
| F08 draft restore | Commit local creation state, reload, edit fields, then return an older status payload | Pending state restores under a stable intent key; status polling preserves current edits. |

For every new form: traverse with Tab/Shift+Tab, submit with Enter, activate
cancel/refresh with Space, inspect status/error announcements and label-to-input
association. Repeat at phone and tablet widths; confirm buttons and long account
text do not require horizontal scrolling. Record actual browser observations
separately from the automated checks below.

## Automated checks

From repository root:

```powershell
npm run test --prefix backend -- test/126-password-recovery.test.ts test/130-recovery-email.test.ts
npm run test --prefix frontend -- src/pages/RecoveryEmail.test.tsx src/pages/PasswordResetPage.test.tsx src/pages/ResourcePolicySettings.test.tsx src/auth.test.ts
npm run typecheck --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
```

Backend cases cover single-use/CAS/session revocation, verified-only issuance,
email-version fencing (including unbind/rebind of the same address), safe link
origin, shared atomic 30/day quota, 5/day recipient allowance and 60-second
cooldown, sender 15-second deadline/no retries, generic asynchronous acceptance,
and no echo/provider-body/token disclosure. React cases cover keyboard form
submission, cancellation, account changes, stale privileged responses and cache
hiding on permission errors. Live Turnstile, actual Resend delivery and browser
device behaviour remain separate acceptance boundaries.
