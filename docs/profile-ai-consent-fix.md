# F2 personal AI consent fix

Review: task-5/REVIEW.md F2 against `aba0483871ec335c3f70e699a79d866f6be2fb6a`.
The reviewer reproduced a peer sending a member's hidden profile without explicit owner consent. The earlier disclosure text did not establish consent.

This repair is limited to the existing `feat/private-member-profiles` worktree. No integration into another branch/worktree, push, deployment, real-provider request or real account edit.

## Authorization

- New additive migration 0017 sets `ai_use_allowed` false on existing rows. Missing profiles are also false. No backfill infers consent.
- Own GET/PUT contract adds required boolean `aiUseAllowed`. Only the authenticated owner can write; unexpected user IDs are rejected. Missing booleans from legacy forms fail validation rather than implicitly enabling processing.
- A separate unchecked checkbox clearly explains the four personal fields sent, including hidden fields; recipient is each joined project's configured AI provider; purpose is task-preference recommendation; an authorized teammate can trigger it. The owner enables by checking and saving and withdraws by unchecking and saving. Public/search settings are independent.
- The choice authorizes processing of the fields visible in this personal editor only. Legacy project-member major, skills, weekly availability and nickname are excluded even when they exist in frozen job input. Models receive only current opaque member IDs, project task workload and explicitly authorized personal profiles.

## Withdrawal

Consent state is part of profileStamp and every owner save increments revision. The follow-up F2-R1 dispatch fix in `profile-ai-dispatch-fix.md` supersedes the earlier check ordering: finish configuration/key/budget I/O, then read and validate current sensitive context in one final SQL snapshot for every request and repair, with no further awaited I/O before fetch. Validate after inference and atomically when inserting proposals or publishing job results. A withdrawn snapshot cannot be published or applied.

GET recommendation jobs rejects stale snapshots without output. Collaboration proposal pagination keeps rows but returns stale status and an empty payload. Client/server no-store prevents stale HTTP cache reuse. The existing safe templates and request/response redaction remain.

Requests already sent to an external provider cannot be recalled; in-flight outputs are discarded. Already applied assignments remain project actions. No claim is made that the application controls third-party retention.

## Verification

Focused tests reproduce peer-triggered requests for a denied profile and old member attributes, owner-only explicit opt-in, publication independence, opted-in outside-group exclusion, legacy rows defaulting false, missing boolean rejection, queued-job withdrawal, in-flight withdrawal, repair withdrawal, atomic publication after withdrawal, stale job reads, stale proposal reads and application rejection. UI tests verify recipient/purpose disclosure, unchecked defaults, independent publication, explicit true save and false withdrawal.

Final full-suite and browser counts are recorded in task-4/CONSENT-REPAIR-REPORT.md. The parent must re-review the final immutable SHA and run combined routing/settings/unified-AI integration QA before release; original approval status does not carry forward automatically.
