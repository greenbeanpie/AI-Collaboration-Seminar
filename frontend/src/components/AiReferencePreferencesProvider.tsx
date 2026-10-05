import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AiReferencePreferences, readAiReferencePreference, subscribeAiReferencePreference, writeAiReferencePreference } from '../ai-reference-preferences';

export function AiReferencePreferencesProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const subscribe = useCallback((listener: () => void) => subscribeAiReferencePreference(accountId, listener), [accountId]);
  const snapshot = useCallback(() => readAiReferencePreference(accountId), [accountId]);
  const visible = useSyncExternalStore(subscribe, snapshot, () => true);
  const value = useMemo(() => ({ visible, setVisible: (next: boolean) => writeAiReferencePreference(accountId, next) }), [accountId, visible]);
  return <AiReferencePreferences.Provider value={value}>{children}</AiReferencePreferences.Provider>;
}
