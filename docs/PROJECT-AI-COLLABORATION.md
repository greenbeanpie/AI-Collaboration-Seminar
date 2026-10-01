# Project AI collaboration

## User flow

1. Create a project and optionally upload up to ten original files. The project AI option is off by default. File count, types and byte limits are checked before creation and again by the server.
2. Uploads establish private project sources. A partial failure or interruption retains the actual project/file state and the same idempotent intent. Refresh requires reselecting unfinished originals; SHA-256 and exact stored bytes are checked before retry. The user can retry, enter the existing project, or explicitly archive the draft with a revision guard. No permanent deletion is added.
3. Enable AI collaboration as a current project owner. A global administrator who is only a project member cannot change it. Model availability, project budget, concurrency and existing repair limits still apply.
4. In collaboration, the latest five source versions are selected by default. Read their text deliberately, resolve missing pages in the source view, and verify source summaries there. Incomplete sources block grounded task generation. Upload completion is not a claim that AI processing is complete.
5. Supply a goal or additional constraints, then create or adjust tasks. Each grounded task includes exact source-version/fragment/page/quote evidence. A request covers at most twenty creates/edits; submitted and accepted tasks cannot be silently rewritten. Manual mode previews the proposal; automatic mode applies a valid result and can start one separately-budgeted assignment continuation.
6. Submit immutable material versions for feedback. The latest confirmed rubric is frozen at enqueue. Scores are for the artifact, never official course grades or person rankings. Each dimension requires confidence and verified body evidence; the server calculates the weighted total. Unread attachments, missing evidence and low confidence require human review before automatic acceptance.
7. The owner can override assistive scores with a reason and revision guard. The original AI report, rubric, evidence and score history are retained separately.

## Boundaries

- The assistant is a project-scoped audited actor, not a new login, credential or service account
- Allowed mutations are bounded task creation/editing, current-member assignment, artifact feedback and assistive scoring
- No project deletion, role expansion, secret/configuration change, budget increase, external execution, new Worker or paid infrastructure is included
- Files, task text, rubric notes and member profiles are data. They cannot grant tool permissions or override server rules
- Existing private-profile consent and membership snapshots remain enforced before each assignment provider attempt
- Closing the project switch stops new collaboration calls and stale automatic application; manually requested source processing and other existing AI features are separate controls
- Queued work freezes project settings, requester authority, source fragments, task revisions, submission versions, rubric and model. Dispatch and mutation guards reject stale snapshots
- No recursive agent timer is introduced. Existing job/outbox recovery, budgets and limits are reused

## API changes

- Project creation adds aiCollaborationEnabled (default false) and scoped idempotent replay
- Collaboration settings add the owner-only project switch and retain independent assignment/evaluation modes
- Collaboration decompose accepts optional taskIds for eligible task adjustment and sourceVersionIds for full source grounding
- Submission reports add rubricScoring and separate humanScoreOverride; POST submissions/{id}/scores records an explicit owner override
- File initialization supports actor/project/payload-scoped idempotent replay

Migration 0021 is additive: existing project data, budgets, modes, task history and AI reports are retained. Existing projects receive the new switch off by default and require an owner opt-in. The independent source-processing/summary migration is delivered separately and must be integrated before production release of the combined flow.

## Verification limits

Focused fixtures cover permissions, CAS conflicts, interrupted/repeated creation, uncertain uploads, private file matching, source freshness, citations, rubric snapshots, confidence, no-rubric behavior and owner score override. Synthetic provider responses incur no model fees. Passing these checks does not establish production model quality, cloud resource availability, or final official grading.
