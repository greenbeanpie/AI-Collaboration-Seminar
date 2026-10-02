# P2 WIP checkpoint

This branch is a recoverable implementation checkpoint, not a release approval.

- Branch: `codex/p2-project-wizard-tools`, based on `01f47cdd084576c64515aa037471ec416b103c3a`.
- Scope: private creation drafts and a five-step wizard; username invitations with recipient acceptance; bounded project file tools and provider-native internet search; DeepSeek Anthropic-compatible preset.
- Formal projects, tasks, files and invitations are created only by the final draft commit transaction. The same draft ID restores the same result after a retry.
- Model search is limited to a user-approved public query. Tests use fixtures only; no actual provider search, saved credentials or live configuration was changed. DeepSeek native search request parameters remain experimental and have not been tested against the live service.
- Confirmed before the Mac disconnected: 26 targeted backend tests passed, 2 wizard frontend tests passed, backend/frontend typecheck and frontend lint passed. Final full-suite/build process results were lost on disconnect; rerun them before release.
- Current migrations are `0022_creation_drafts_tools.sql` and `0023_username_invitations.sql`. The separately owned recycle-bin work also uses migration 0022, so migration numbering must be coordinated before integration.
- Shared integration point: `backend/src/services/files.ts`. New project file tools currently select only files with `status='available'`; recycle-bin removal must also make removed files unreadable here and in every subsequent source-fragment read.
- Other modified AI files: `ai/calls.ts`, `ai/gateway.ts`, `services/agent.ts`, `services/budget.ts`, `services/collaboration-ai.ts`, APIs `agents.ts`, `collaboration.ts`, `jobs.ts`, and `app.ts`. OpenAPI files are generated from these changes.
- Do not import the abandoned cloud draft or title patch `9119314`. Do not merge main or deploy this checkpoint; the parent coordinates serial publication.

Local dependency symlinks are intentionally excluded from commits. Source code and test fixtures are all in this branch.
