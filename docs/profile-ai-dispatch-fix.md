# F2-R1 dispatch authorization repair

Review source: task-5/CONSENT-REVIEW.md and consent-source-audit-results.json, reviewing `ce983e2f71c0e1a53d2d162a2aa4b83610c97cf5`.

The reproduced sequence was budget claim, valid authorization check, an awaited AI configuration read during which the owner withdrew consent, and one provider request containing the hidden biography. Discarding its response did not undo disclosure.

The assignment path now loads no personal text up front. Every first request and repair completes endpoint/key preparation, configuration preflight and budget I/O before `recommendationDispatch` performs one final SQL read. That query validates the job's member IDs, membership row IDs, profile revisions and explicit consent flags, requester membership, and current enabled AI configuration in the same snapshot. It returns only current members' IDs/task workload and profiles whose owners explicitly opted in. Legacy member attributes remain excluded, and existing/missing profiles remain denied by default.

After that read, only synchronous parsing, message/body construction, size validation, and the synchronous dispatch marker occur before fetch initiation. No configuration, key, budget, logging or other awaited I/O follows. Repair requests rebuild their context through the same final read; frozen personal text is never reused. A denied final read starts no provider fetch and cannot trigger a paid repair. Both ordinary assignment jobs and collaboration assignment jobs share this path. Other AI operations do not receive profiles and retain their existing behavior. No API or migration changed in this increment.

Post-inference validation and atomic publication/application guards remain. Outputs and stored AI payloads remain redacted or restricted to IDs and fixed public templates.

## Revocation boundary

The final database read is the dispatch authorization boundary. Withdrawal completed before this read invalidates the snapshot and prevents dispatch, including withdrawal during earlier configuration/key/budget awaits. A database authorization read and a remote HTTP request cannot be one atomic transaction. This repair does not claim an absolute cutoff across a withdrawal concurrent with an already-authorized dispatch, recall requests already started, control provider retention, or undo previously applied assignments. Consent changes invalidate resulting recommendations and block their publication/read/application. The owner UI explicitly says authorization is reread before sending, started requests cannot be recalled, and results are discarded after authorization changes.

## Regression evidence

- Exact reviewed configuration-read race on first request and repair, for ordinary and collaboration assignment jobs: four cases verify withdrawal completed, no provider call after withdrawal, failed job with null result, and no proposal.
- Final context-read boundary: committed consent, membership or configuration changes each prevent provider fetch.
- Existing consent tests continue covering default deny, explicit owner-only opt-in, publication independence, peer triggers, legacy-attribute exclusion, outside-group exclusion, queued/in-flight withdrawal, stale job/proposal reads, and atomic publication/application rejection.

Final verification: backend 37 files / 278 tests and frontend 32 files / 133 tests passed; both TypeScript checks, frontend lint/build, and `git diff --check` passed. Focused race suite: 3 files / 45 tests passed. Backend full run printed the previously observed workerd RPC-disposal/canceled-request teardown warnings and exited successfully. Logs and immutable commit/patch IDs are in task-4/DISPATCH-REPAIR-REPORT.md. Browser QA from the consent repair is retained; this increment changes only disclosure text on the frontend, so no new browser run was claimed. Tests use synthetic accounts and mocked providers only. This work did not push, deploy, change model configuration, modify real accounts, read credentials, or integrate another worktree. Per the parent's completion instruction, this increment addresses the known finding without further vulnerability investigation. Combined settings/router/AI integration and publishing belong to the parent.
