# Project workspace navigation

The main project navigation has five entries on desktop and in the mobile selector:

- 概览: existing project overview and activity history (`/ledger`)
- 要求与任务: `/work` shows saved requirement/rubric summaries above the existing task board and its inline AI collaboration actions. `/requirements` and `/tasks` remain directly accessible
- 资料: `/data` shows imported sources and result materials together, with separate headings, real saved records and each section’s actions. `/sources` and `/materials` retain the full workspaces
- 团队: `/team` shows the existing members workspace plus team settings (owner only) and export entry sections. Existing `/settings` and `/export` URLs remain valid
- 检查与演练: existing reviews and rehearsal workspaces share one main group

No existing route is redirected or removed. Search parameters and hashes remain on deep links. Navigation uses React Router links and its existing blockers; it does not bypass draft decisions or mutate project data.

AI material drafting/review lives in an expandable result-materials panel. It mounts only when opened; collapsing it keeps entered instructions and ongoing job recovery mounted. The old `/ai` deep link opens the same panel in the results workspace. No AI request is automatically started by opening a group, summary, or panel; existing explicit run and review/adoption controls are unchanged. Task decomposition and instruction adjustment remain in the existing task board collaboration component.

Lists display independent loading, failure and empty states. A failed list does not become a zero count or hide another section’s saved records. Heavy editors are not mounted by the data summary. Main links and secondary actions wrap; mobile uses a five-option selector and wrapping section links rather than horizontal scrolling.

## Production browser checks

- At desktop and narrow mobile widths, inspect all five groups for horizontal overflow
- On the default data page, verify both source and result sections are visible and show server records
- Open source evidence, task query links, result editing and the old `/ai` link; confirm queries/hashes and Back/Forward behavior survive
- Enter a draft and cancel a group/section navigation; ensure existing draft protection remains effective
- Open AI assistance, enter an instruction, collapse and reopen; verify the input remains and no generation starts until explicitly requested
- Verify a member cannot see owner-only team-settings entries, while allowed member/export actions remain available
