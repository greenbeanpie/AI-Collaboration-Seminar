# Compact workspace release verification

Verified on 2026-10-02 (Asia/Singapore).

## Changes

- Material attachments align with editor content. Discussion and material versions are independently collapsed, five items per page. Direct version links open the matching historical page.
- AI assistance uses a small button and preserves mounted workflow state when collapsed.
- Task detail separates submission, settings, and one-round-per-page history. The latest submitted round is collapsed beneath the new submission form. Switching views retains the draft.
- Task cards show at most two lines and 60 Unicode characters. Long descriptions use cached AI summaries; short descriptions require no model call. Failed summaries retain a marked source excerpt and explicit retry.
- Task, data, and assessment pages omit redundant headings; project content starts 12px below navigation.
- Additive migration `0032_task_summaries.sql` retains original task/submission data. Summaries are keyed by project, task and description/criteria hash, use existing textEconomy config and budget accounting, and reject outdated results.

## Verification results

| Check | Result |
| --- | --- |
| Backend Vitest | 75 files, 706 tests passed |
| Frontend Vitest | 81 files, 432 tests passed |
| Backend/frontend TypeScript | Passed |
| Frontend ESLint | Passed |
| Frontend production build | Passed |
| Service Binding forwarding checks | Passed |
| Production configuration preflight | Passed |
| Local real HTTP integration | 102 checks passed on port 8798; disposable local project archived |
| Chromium UI, 1440px and 390px | Pagination, disclosure, version deep link, draft retention, keyboard activation and no horizontal overflow passed |

The same fixture task card decreased from 185.8px to 163.7px at 1440px and from 218.0px to 193.8px at 390px. Screenshots and machine-readable results are in `output/compact-workspace/before/` and `output/compact-workspace/after/`.

The full Workers test pool emits existing RPC disposal/cancelled-request teardown diagnostics while all tests pass; these are not suppressed. This fixture suite does not call a real model or write production project data. Production deployment/model verification is recorded separately in the release report.

## Reproduce

Run `npm run typecheck`, `npm run lint`, `npm run test:frontend`, `npm run test:backend`, `npm run build`, `npm run verify:worker`, and `npm run preflight:deploy -- production`.

For the UI fixture, run `node scripts/verify-compact-workspace-ui.cjs --serve` in one terminal. Set `UI_PLAYWRIGHT_PATH` to the installed Playwright module and `UI_CHROMIUM_PATH` to Chrome/Chromium, then run `node scripts/verify-compact-workspace-ui.cjs` in another terminal. The fixture binds only to loopback ports 5197 and 8797.

For real local HTTP checks, apply local migrations, initialize the local test administrator with the existing bootstrap script, and run Wrangler on an unused port with an explicit local persistence path and matching local Origin. Set `INTEGRATION_URL` to that loopback origin and run `node scripts/verify-integration.mjs`. Private credentials and production D1 backups remain Git-ignored.
