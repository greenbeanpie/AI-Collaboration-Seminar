# Personal profiles integration handoff

Base: `914d3cb1a7894fc9a8be5811e458c17b96843a20`; branch `feat/private-member-profiles`.
Worktree: `C:/Users/hmz/Documents/Codex/2026-10-01/task-4/profile-search`.
No push, main merge, deployment, real AI call, real profile edit, credential read or key modification.

## Parent integration

No edits to frontend App.tsx, AppShell.tsx, main.tsx, SettingsLayout.tsx or AccountSettingsPage.
Exports from `frontend/src/pages/PersonalProfiles.tsx`:

- `PersonalProfilePage`: register under existing authenticated settings layout at `/app/settings/privacy`; add ordinary-user privacy tab.
- `ProfileSearchPage`: proposed authenticated route `/app/people`; add a discoverable search entry.
- `PublicProfilePage`: proposed authenticated route `/app/people/:username`; search links already target this route.

`settings-dirty.ts` is an exact copy of task-3's handoff implementation, necessary for isolated typechecking; retain the shared task-3 version when integrating. New page calls `useSettingsDirty`; never sends field contents through context or notifications. Nickname/password remain in the existing settings pages. Route/menu integration is intentionally reserved for the parent and must be completed before release. Current baseline production build therefore does not yet include these unrouted pages; component tests and independent browser harness do exercise them.

Backend registration adds `registerPersonalProfileRoutes(app)` to `backend/src/app.ts`; extends no-store matching for `/profiles`. Regenerate OpenAPI/types after merging parallel backend changes. Additive migration `0016_personal_profiles.sql` creates a separate opt-in table with no backfill and no account role changes. Coordinate migration number if another branch adds 0016.

AI shared-file coordination: `services/agent.ts` adds optional `privateContext` and `beforeCall`; `ai/gateway.ts` adds `privateContext` and per-request `cf-aig-skip-cache:true`, `cf-aig-collect-log:false`. Preserve these additions when merging unified endpoint work. They reuse the resolved model config and existing provider adapters, never replace model settings.

## APIs

All endpoints require a valid password-account session. All responses, including errors, use `Cache-Control: no-store`.

- `GET /api/v1/auth/personal-profile`: own fields, visibility flags, searchable, `aiUseAllowed` and revision; missing row returns blank/private revision 0 and AI use false.
- `PUT /api/v1/auth/personal-profile`: header `X-Account-Settings: 1`; full body `{expectedRevision,searchable,aiUseAllowed,bio,major,specialties,preferredRoles,visibility:{bio,major,specialties,preferredRoles}}`. `aiUseAllowed` is a required explicit boolean; an old client omitting it fails validation. Strict validation; ID cannot be supplied. Optimistic conflict 409; only owner from session can update. Does not change nickname or other account settings.
- `GET /api/v1/profiles/search?username=NAME`: case-insensitive full username match, 3–32 ASCII username characters. Returns `{items:[{username,displayName}],nextCursor:null}` with at most one item. Optional `page=1` only; no prefixes, global counts or enumeration endpoint. Per-account 30/minute and per-IP 120/minute persistent atomic rate limit.
- `GET /api/v1/profiles/:username`: `{profile:null}` both for absent and undiscoverable accounts, otherwise username/displayName plus individually published fields only. No user ID/email/role/account-status fields. Closing search hides the whole public profile on the next request; previously viewed data cannot be retroactively removed from another person's screen or memory.

New and existing accounts remain unsearchable until an explicit save opts in. Legacy accounts without usernames cannot be found. Hidden fields are absent from public JSON, not merely concealed in CSS. Self biography supports a deliberately small Markdown subset rendered as React text/elements: headings, bullets, bold, inline code, HTTPS links with noreferrer. Raw HTML is literal text; images never load; unsafe/credentialed URLs are not links.

## AI privacy boundary

Personal profiles are loaded only through a JOIN with current project members with `ai_use_allowed=1`, immediately before assignment inference, independently of publication flags. Migration `0017_profile_ai_consent.sql` defaults all existing rows to false; no account, membership or publication flag implies consent. The profile page requires the owner to choose and save an independent checkbox after explaining recipients, purpose and peer-triggered recommendations across joined projects. No private values are added to job snapshots, project member APIs, notifications or task evaluation/grading. Task decomposition does not receive private profiles because its arbitrary generated task prose would create a disclosure channel; the resulting task IDs are matched to member IDs in the assignment continuation.

Model `members` are rebuilt from live project membership as opaque IDs plus task-derived workload. Legacy member major, skills, availability and nickname are never passed from frozen input or project-member fields. Opting in authorizes only the personal fields shown in this editor, not hidden legacy group data.

Persisted `profileStamp` contains membership row IDs, user IDs, profile revisions and consent state only. New jobs capture it; missing or pre-consent stamps on old frozen jobs fail closed. Check before every request including repair, before and after the budget claim, and again after inference; check current AI config as well. Output validation restricts task/member IDs to the supplied set and replaces all outward explanations with fixed templates. Legacy model reason/considerations fields may be accepted for compatibility but are transformed away immediately. Full request/response records are replaced with `{redacted:true}`, while usage/cost metadata remains. This is enforced in code, not by a secrecy prompt.

Collaboration proposal insertion/application and recommendation job result publication add an atomic SQL guard: same number and identities of members, same profile revisions and consent state. Profile edits/withdrawal, new members, departure/rejoin and old proposals without stamps fail safely. GET jobs rejects stale recommendation outputs; proposal lists return stale status and empty payload, preserving paging. Both responses and the client use no-store. Existing task revision, project settings, role, member workload and config guards remain. Ordinary manual assignment remains a user's explicit action, with existing project membership/task revision checks. Withdrawal cannot retract a request already in flight or undo a previously applied assignment; its resulting recommendation is discarded and future requests fail the updated snapshot checks.

External configured AI services receive the necessary profiles as disclosed in the UI. Local redaction and Cloudflare no-log/no-cache headers cannot promise another provider's independent retention policy; no real-provider integration was exercised. Headers verified against official Cloudflare docs: https://developers.cloudflare.com/ai-gateway/observability/logging/ and https://developers.cloudflare.com/ai-gateway/features/caching/ .

## Verification

Consent repair verification: backend full suite 37 files / 270 tests passed; frontend full suite 32 files / 133 tests passed. A subsequently added budget-write withdrawal boundary test passed in the final targeted suite: 4 files / 48 tests. Both TypeScript checks, frontend lint, frontend production build and git diff --check passed. Workerd printed existing RPC disposal/canceled-request teardown warnings during the full backend run, which completed successfully. Logs: task-4/consent-backend-full.log, consent-frontend-full.log and consent-final-focused.log. Browser consent UI artifacts: task-4/consent-qa; these pages still await combined router/settings integration as described above.

Tests cover authenticated access, owner-only writes/IDOR rejection, all-private defaults, exact case-insensitive search, no sensitive response keys, immediate disable, strict lengths/page input, rate limits, optimistic conflict, group-only model inputs, sanitized output and R2 snapshots, old jobs, member removal, profile/config changes during inference, repair after withdrawal, and atomic stale proposal rejection. Frontend tests cover Markdown XSS/images/URLs, private preview, conflict preservation, save revision/dirty-state, search navigation and unavailable profiles.

Browser QA uses independent headless Chrome 9344 and Vite 5194 with all API responses mocked. Desktop and 390px editor/search/public pages tested; no horizontal overflow, hidden field absent in preview/public display, script inert and no image loads. Screenshot/report artifacts are in task-4/profile-qa after packaging. This is component/harness QA, not final combined App/settings/navigation QA; parent must run that after integration. No production database migration or live model call was performed.
