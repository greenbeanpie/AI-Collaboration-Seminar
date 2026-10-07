import { offlineAccount } from '../../offline/store';
// Tests and initial session hydration may not yet have an account. Never share an anonymous persisted namespace.
const unboundAccount = globalThis.crypto?.randomUUID?.() ?? `unbound-${Date.now()}-${Math.random()}`;
export function accountStorageKey(tail: string): string {
  return `ai-office:account:${offlineAccount()?.id ?? unboundAccount}:${tail}`;
}
