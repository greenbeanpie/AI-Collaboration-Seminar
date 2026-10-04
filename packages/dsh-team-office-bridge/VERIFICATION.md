# Plugin verification record

2026-10-04, isolated Windows worktree. No production model request or personal DSH profile was used.

- `npm test`: 39 passed, 1 skipped (ordinary Windows file symlink permission). Windows directory junction rejection and immutable input checks passed.
- Material transfer: synthetic 120 MiB streamed to atomic disk file with incremental SHA-256 and less than 20 MiB measured ArrayBuffer growth; one-byte excess aborted and never published a partial input. Permanent preparation failures (404, invalid path, disk full) and known pre-prompt create failures send a static failed event; transient 503 retains the unexecuted run for retry.
- `npm run check`: three shipped JS source files pass syntax checks.
- `npm pack`: produces standalone `greenbeanpie-dsh-team-office-bridge-0.1.0.tgz` including bundle patch, real host runtime and built browser module factory.
- Official Desktop `0.2.0-rc.2` CLI `dsh plugin --profile web add <tgz>` with isolated `DSH_HOME`: installs exactly one package, enables bundle automatically, no duplicate Cordis or DSH installation.
- Official Desktop web startup with installed bundle: succeeds, generated browser boot graph includes plugin; config response reports `compatible:true`, `dshVersion:0.2.0-rc.2`.
- Actual shared carrier: anonymous config request 401; authenticated config request 200; foreign Origin request 403.
- Actual `sessionController.create` and `resolveAgent`: creates empty bridge session without invoking model; completion schema visible to bound Agent and absent globally.
- DSH startup emits upstream `DEP0180 fs.Stats constructor` warning. Plugin does not suppress it.

Actual RC2 lifecycle smoke also passed: builtin DeepSeek provider calls local HTTP SSE fixture (3 requests, zero paid requests); BridgeRunner creates and prompts actual DSH session, scoped completion tool executes, inspection shows matching durable user-rpc and normal completed turn, harmless artifact reaches ready_for_review. Reproduce with `npm run smoke:host`; safe metadata in `test/smoke-host-result.json`.

Not yet verified: native directory picker manual click, actual browser configuration card interaction, latest-source full runtime boot, paid model execution quality, backend production synchronization and deployment. Source API compared against official `5badb15009ae1756c3afe0ae0cef1faafc290ccc` (`0.2.1-alpha.1`). Installation via real remote tarball URL still requires publishing the package at that fixed endpoint.

Isolated smoke homes are ignored and retained as evidence; their processes were stopped. Automated approval review refused the cleanup command (generic blocked by policy).
