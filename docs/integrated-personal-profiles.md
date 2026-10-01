# Integrated personal profiles

The profile feature from `aba0483871ec335c3f70e699a79d866f6be2fb6a` is combined with the update, notification, settings and unified AI baseline `c3f5e98ed85360d8add434f8cb882533bdbee8e0` on a temporary local integration branch.

- `/app/settings/privacy` is under the authenticated shared SettingsLayout. Its ordinary-user tab is alongside account profile/security/appearance. Admin-only tabs retain their existing guards.
- `/app/people` and `/app/people/:username` are authenticated sibling routes. The existing sidebar adds one search entry and retains one global Settings entry.
- The privacy editor uses the existing shared dirty guard, notification scope and confirmed-update flow. Field contents are never sent to the notification history or dirty context.
- Existing and new accounts remain undiscoverable unless their owner explicitly opts in. Visibility flags retain private defaults. AI use defaults denied independently of publication; the owner alone can grant or withdraw it. No migration backfill enables search, publishes values or grants AI consent.
- Unified AI routing and advanced drafts are preserved. Private assignment requests use the resolved frozen configuration, membership/profile guards and provider no-cache/no-log markers; persisted request/response content remains redacted and outward recommendation text remains templated.
- Migrations `0016_personal_profiles.sql` and `0017_profile_ai_consent.sql` are additive and unique in this combined tree, applied in that order. Local tests apply them only to synthetic isolated test databases. Production migration and deployment are separate release actions.

OpenAPI and frontend API types were regenerated from the combined backend. See `personal-profiles-handoff.md` for the API/privacy contract and `unified-ai-mode.md` for model routing details. Their earlier unmounted-page notes describe the independent feature worktree; the routes above are now mounted in this integrated tree.

Regression scripts include `e2e/profiles-integration.mjs` (real integrated frontend, synthetic mocked APIs), `e2e/settings-navigation.mjs` and `e2e/ai-unified-ui.mjs`. The latter accepts a loopback `WORKBENCH_URL` and optional `QA_OUTPUT`. Browser fixtures do not provide evidence of real-provider retention or production deployment headers. Backend tests exercise the actual Worker API and local database, including hidden fields across all three account roles and unified-model private inference.
