/** Only protected routes on this origin can resume after authentication. */
export function safeReturnTo(value: string | null | undefined): string {
  const unsafe = (text: string, raw = false) => [...text].some(char => char === '\\' || char.charCodeAt(0) < (raw ? 33 : 32) || char.charCodeAt(0) === 127);
  if (!value || !value.startsWith('/') || value.startsWith('//') || unsafe(value, true)) return '/app';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || unsafe(decoded)) return '/app';
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/app(?:\/|$)/.test(url.pathname) || !/^\/app(?:\/|$)/.test(new URL(decoded, window.location.origin).pathname)) return '/app';
    return url.pathname + url.search + url.hash;
  } catch { return '/app'; }
}

export function loginContinuation(path: string): string {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(path))}`;
}
