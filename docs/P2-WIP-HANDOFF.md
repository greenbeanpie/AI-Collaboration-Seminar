# P2 integrated release candidate

Publication remains coordinated by the parent task. No main push, production migration, deployment, live model request or saved credential/configuration change was performed by this worktree.

- Integrated branch: `codex/p2-project-wizard-tools-integrated`, rebased onto published recycle-bin commit `db56a225e0a327ddc8ff2efda9400595b86195b3`.
- Original recoverable WIP remains unchanged on `codex/p2-project-wizard-tools` at `87cc3ad9334ca16b329c5eefc86ebc574436c6c8`; no force push was used.
- Scope: private five-step creation drafts; files staged without a formal project; username invitations accepted/rejected on the homepage; bounded file tools; provider-native internet search; DeepSeek Anthropic-compatible preset.
- Final creation uses a D1 transaction guarded by draft ID/revision and replays the same encrypted result. Confirmed task decomposition is reused without another model call. Cancellation and file removal retain recoverable data.
- Migrations are now `0023_creation_drafts_tools.sql` and `0024_username_invitations.sql`, following the published `0022_file_recycle.sql`. No production migration was executed here.
- Lifecycle integration uses shared `loadActiveSourceVersion` and `sourceLifecycleGuard`. File tools exclude deleted files/sources, freeze at most160 dynamic file/source snapshots in job input, and verify current permissions, job state and lifecycle before each model request and on return. Delete/restore cannot revive old snapshots. Deletion cancels affected tool jobs, including metadata-only files without a source; incurred/unknown costs remain auditable.
- Shared atomic guards protect assistant result persistence and collaboration proposal creation/adoption, including dynamically read files. Existing selected-source and permission guards were retained. New draft imports preserve immutable staged file IDs and receive lifecycle defaults1.
- Combined validation: backend57 files /561 tests passed with `--maxWorkers=2`; frontend61 files /327 tests passed; backend/frontend typecheck, frontend lint, frontend production build, generated OpenAPI/type contracts, Service Binding verification and production static preflight passed. Existing Workers RPC disposal diagnostics appeared but the full test process exited0.
- The local HTTP integration script requires an explicitly running loopback stack and local test-account setup; it was not completed in this worktree. Browser layout QA is also pending. Neither is claimed as passed.
- Wizard and username-invitation flows have final automated regression coverage, including no early project/invitation, commit replay/rollback, recipient isolation and concurrent capacity. DeepSeek preset and native-search protocol behavior have fixture regression coverage; exact live DeepSeek search parameters, real supplier support/billing and live citation formats remain unverified and are labelled in the UI/docs.
- Native search accepts only this run's user-approved public query and uses the configured supplier. No new search supplier/key/service is added. Unsupported configurations return unavailable; no text-only claim is accepted as evidence of search. Native additional costs remain unknown and finite-budget projects cannot use search.
- Do not import the abandoned cloud draft, blocked title patch `9119314` or P1. The integrated branch does not contain that title patch.

Local dependency symlinks are excluded from commits. The original WIP is independently recoverable from its remote branch.
