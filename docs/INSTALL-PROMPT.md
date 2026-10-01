# Install prompt placement

The install suggestion is shown only on the authenticated `/app` route, whose
heading is `我的项目`. Browser install eligibility is captured before login, so
an early `beforeinstallprompt` event is retained for the dashboard.

It is shown on the first eligible dashboard visit in the current tab session.
Leaving and returning does not repeat it. The existing close control and
session-scoped dismissal remain; this is not a permanent account preference.
When session storage is blocked, an in-memory fallback covers route navigation.
Actual installation still requires clicking the install button and remains
subject to browser/platform install support. Other pages do not show the prompt.

Regression coverage includes early eligibility before login, the authenticated
route, navigating away and back, close persistence, unavailable storage, and
explicit-gesture-only installation.
