import { createContext, useContext } from 'react';

export const AiReferencePreferences = createContext<{ visible: boolean; setVisible: (visible: boolean) => boolean }>({ visible: true, setVisible: () => false });
export function useAiReferencePreferences() { return useContext(AiReferencePreferences); }

export const aiReferencePreferenceKey = (accountId: string) => `buwei:ai-reference-badges:${accountId}`;
const temporary = new Map<string, boolean>();
export function readAiReferencePreference(accountId: string): boolean {
  if (temporary.has(accountId)) return temporary.get(accountId)!;
  try { return localStorage.getItem(aiReferencePreferenceKey(accountId)) !== 'hidden'; }
  catch { return true; }
}
export function writeAiReferencePreference(accountId: string, visible: boolean): boolean {
  let saved = false;
  try {
    localStorage.setItem(aiReferencePreferenceKey(accountId), visible ? 'visible' : 'hidden');
    temporary.delete(accountId); saved = true;
  } catch { temporary.set(accountId, visible); }
  window.dispatchEvent(new CustomEvent('ai-reference-preference-changed', { detail: { accountId } }));
  return saved;
}
export function subscribeAiReferencePreference(accountId: string, listener: () => void): () => void {
  const changed = (event: Event) => {
    if ((event as CustomEvent<{ accountId: string }>).detail.accountId === accountId) listener();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === aiReferencePreferenceKey(accountId)) {
      temporary.delete(accountId); listener();
    }
  };
  window.addEventListener('ai-reference-preference-changed', changed);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener('ai-reference-preference-changed', changed);
    window.removeEventListener('storage', storage);
  };
}
