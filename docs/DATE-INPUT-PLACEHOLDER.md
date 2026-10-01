# Date input empty display

The workspace's project creation/settings, requirements, tasks and decision ledger,
and all five guest-demo date controls, share the empty hint `请选择日期`.

Only empty, unfocused presentation changes. Pointer focus keeps an empty field blank until a date is selected. Explicit
keyboard editing reveals native segments for accessible partial entry; the native
picker remains available. No focus or click assigns a default date. Native `date` and
`datetime-local` input types, ISO values, labels, validation, disabled/read-only
states, clearing, and existing timezone conversion stay unchanged. No database or
API changes are required.

React uses `DateInput`; the standalone guest uses `dateInput` plus delegated
input/change synchronization. Both load `/date-input.css`. The visual hint is
hidden from assistive technology and uses generated content so it does not alter
the existing field label.

Verification: frontend typecheck, lint, full Vitest suite, build, production
preflight, Service Binding check. Browser coverage should include empty/filled,
focus/blur, clearing, keyboard entry and the native picker; do not submit real
project data merely for UI verification.
