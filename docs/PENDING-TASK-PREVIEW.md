# Project pending-task preview

The project overview pending-items card shows up to two unfinished tasks from the
existing, project-authorized API list. Current-user assignments rank first;
within each group actual creation time sorts newest first, with task ID as a
stable tie-breaker. Completed tasks are excluded. No extra cross-project fetch
or new data permission is introduced. Existing other project reminders remain.

Each task links to `/app/projects/:projectId/tasks?task=:taskId`. The legacy task
editor opens only IDs in the current authorized list. Unknown IDs, permission
errors, removed records and lifecycle-managed tasks do not open the legacy form.
The collaboration task UI handles lifecycle-managed targets separately.

Closing clears only the task query parameter; Back/Forward follows the selected
task. Background refetches of the same task preserve unsaved editing state and
existing optimistic revision conflict handling. Changing project scope closes
an old task. No write occurs merely from following a link.
