/** A unique client id: the platform UUID when available, with a time/random fallback for older runtimes. */
export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
