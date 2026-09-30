/* Runs before rendering: shared controller for first paint and React. */
(function () {
  var key = 'ai-office-theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var preference = 'system';
  function valid(value) { return value === 'light' || value === 'dark' ? value : 'system'; }
  try { preference = valid(localStorage.getItem(key)); } catch { /* Session-only when storage is blocked. */ }
  function apply() {
    var theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#111827' : '#f4f6fa';
    window.dispatchEvent(new Event('office-theme-change'));
  }
  window.addEventListener('office-theme-select', function (event) {
    preference = valid(event.detail);
    try { if (preference === 'system') localStorage.removeItem(key); else localStorage.setItem(key, preference); } catch { /* Keep the in-memory choice. */ }
    apply();
  });
  window.addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  media.addEventListener('change', function () { if (preference === 'system') apply(); });
  apply();
}());
