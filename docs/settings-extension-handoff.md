# Settings extension handoff

Current isolated baseline: `914d3cb1a7894fc9a8be5811e458c17b96843a20`.
This worktree changes update notifications and settings navigation only. Account search,
public Markdown profiles, field visibility and private AI-recommendation consent belong
to the subsequent task; no API or placeholder UI for those features is implemented here.

## Routes and ownership

- `frontend/src/App.tsx` owns nested `/app/settings` routes; index redirects to `profile`.
- `frontend/src/pages/SettingsLayout.tsx` owns the category tabs and shared dirty-form guard.
- `/app/settings/profile`: `AccountSettingsPage section="profile"`, existing nickname.
- `/app/settings/security`: `AccountSettingsPage section="security"`, existing password form.
- `/app/settings/appearance`: existing theme controls.
- `/app/settings/accounts`: administrators only, `AdminAccountsPage`.
- `/app/settings/ai`: super administrators only, `AiSettings`.
- Old `/app/admin/accounts` and `/app/admin/ai` redirect to their corresponding tabs.
- Project-local `/app/projects/:projectId/settings` stays separate.
- `/app/settings/privacy` is the agreed extension path, **not yet registered or exposed**.
  Add it alongside `profile` when its implementation is ready; ordinary account privacy
  should not inherit an administrator-only guard.

`AppShell.tsx` has the one global settings navigation entry. `main.tsx` uses a data router
(`createBrowserRouter`/`RouterProvider`) to support `useBlocker`. Do not revert to BrowserRouter.

## Existing API conventions (unchanged)

- Session: `GET /api/v1/auth/session`, query cache key `['session']`, `useSession()`.
- Nickname: `PATCH /api/v1/auth/profile`, body `{ displayName }`, header `X-Account-Settings: 1`.
  Typed result `AccountProfileResponse` contains `user`; update the session query on success.
- Password: `POST /api/v1/auth/password`, body `{ currentPassword, newPassword }`, same header;
  existing result type `AccountPasswordResponse`. Keep its confirmation and session invalidation.
- Use `frontend/src/api/client.ts` typed API helpers and generated `api/openapi.ts`; add new
  API contracts in the backend then regenerate types. This task has no backend changes.
- Server authorization remains authoritative. Hidden tabs alone are not access control.

## Dirty state and notifications

New editable settings call `useSettingsDirty(boolean)` from `pages/settings-dirty.ts`.
Its returned function clears the guard synchronously after a successful action that navigates.
Only booleans cross this context; do not lift passwords or private field values into it.

The layout blocks route changes and browser unload, supports cancellation/Back/Forward,
and ignores navigation to the same pathname/search/hash. Notification center Back uses
a temporary same-URL native history entry and must preserve form state.

`settings-before-leave` is a cancelable event used before logout; cancel must occur before
the API DELETE. `settings-leave-failed` restores protection if logout fails.
`app-update-reload` is emitted only after the shared update confirmation; the layout then
skips a duplicate beforeunload prompt.

`public/app-updates.js` owns in-memory notification history, capped at 30. `PwaStatus`
in App dispatches `app-notification-scope` with account and project identity; switching
scope clears history. Emit `app-notification` only with safe summaries (`text`, `kind`,
optional stable `id`). Never put Markdown body, hidden profile values, passwords, API
keys, or raw provider errors into notification history.

Coordinate changes to App.tsx, SettingsLayout.tsx, main.tsx, AppShell.tsx and the existing
AccountSettingsPage with this patch before integration. Neither worktree is authorized
to push main or deploy yet.
