# P2 WIP checkpoint

This branch is a recoverable implementation checkpoint, not a release approval.

- Branch: `codex/p2-project-wizard-tools`, based on `01f47cdd084576c64515aa037471ec416b103c3a`.
- Scope: private creation drafts and a five-step wizard; username invitations with recipient acceptance; bounded project file tools and provider-native internet search; DeepSeek Anthropic-compatible preset.
- Formal projects, tasks, files and invitations are created only by the final draft commit transaction. The same draft ID restores the same result after a retry.
- Model search is limited to a user-approved public query. Tests use fixtures only; no actual provider search, saved credentials or live configuration was changed. DeepSeek native search request parameters remain experimental and have not been tested against the live service.
- Recoverable checkpoint `3d84643fa9621248443b7ea40a545e3cad467307` was pushed to the same authorized repository branch after reconnection.
- Confirmed after reconnection: full backend 54 files / 521 tests passed; full frontend 59 files / 315 tests passed; backend/frontend typecheck, frontend lint and production frontend build passed. Runtime diagnostics from Workers disposal appeared, but the test process completed with exit code 0. Frontend fixes guard absent search-capability data and hide the search control while project AI is disabled.
- Browser layout QA is pending; all provider-native search tests use fixtures, with no live provider billing requests.
- Current migrations are `0022_creation_drafts_tools.sql` and `0023_username_invitations.sql`. The separately owned recycle-bin work also uses migration 0022, so migration numbering must be coordinated before integration.
- Shared integration point: `backend/src/services/files.ts`. New project file tools currently select only files with `status='available'`; this is insufficient for the incoming soft-delete contract and must be integrated before release. Filter `files.deleted_at`, load active source versions with `source-lifecycle` helpers, freeze file/source lifecycle versions for tool results, and recheck them before every subsequent provider request so remove/restore cannot reuse old reads. Draft-to-project imports should use the new lifecycle defaults and preserve the immutable staged file ID. No helper is guessed or duplicated before receiving the recycle-bin commit.
- Other modified AI files: `ai/calls.ts`, `ai/gateway.ts`, `services/agent.ts`, `services/budget.ts`, `services/collaboration-ai.ts`, APIs `agents.ts`, `collaboration.ts`, `jobs.ts`, and `app.ts`. OpenAPI files are generated from these changes.
- Do not import the abandoned cloud draft or title patch `9119314`. Do not merge main or deploy this checkpoint; the parent coordinates serial publication.

Local dependency symlinks are intentionally excluded from commits. Source code and test fixtures are all in this branch.
