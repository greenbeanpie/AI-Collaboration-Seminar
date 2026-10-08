import { offlineAccount } from '../../offline/store';
import { newId } from '../../api/ids';
// Tests and initial session hydration may not yet have an account. Never share an anonymous persisted namespace.
const unboundAccount = newId();
export function accountStorageKey(tail: string): string {
  return `ai-office:account:${offlineAccount()?.id ?? unboundAccount}:${tail}`;
}
