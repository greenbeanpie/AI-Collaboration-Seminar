import { expect, it } from 'vitest';
import { safeReturnTo, loginContinuation } from './auth-continuation';
it('preserves protected invitations, task details and bridge pairing', () => {
  for (const path of ['/app/join?code=abc123', '/app/projects/p/tasks?taskId=t#details', '/app/agent-bridges/connect?pairing=id']) {
    expect(safeReturnTo(path)).toBe(path); expect(loginContinuation(path)).toBe('/login?returnTo=' + encodeURIComponent(path));
  }
});
it('rejects external, protocol-relative, backslash, encoded and login-loop targets', () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/%2f/evil.example', '/app/../../login', '/app/%2e%2e/login', '/app/%5cevil', '/app/%00bad', '/login?returnTo=/app', '/application', '/app/%zz']) expect(safeReturnTo(value)).toBe('/app');
});
