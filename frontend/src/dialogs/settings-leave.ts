export interface SettingsLeaveRequest { waitUntil: (decision: Promise<boolean>) => void }
/** Keeps synchronous vetoes compatible, but waits for in-page confirmations before any logout write. */
export async function requestSettingsLeave(): Promise<boolean> {
  const decisions: Promise<boolean>[] = [];
  const event = new CustomEvent<SettingsLeaveRequest>('settings-before-leave', { cancelable: true, detail: { waitUntil: decision => decisions.push(decision) } });
  if (!window.dispatchEvent(event)) return false;
  try { return (await Promise.all(decisions)).every(Boolean); } catch { return false; }
}
