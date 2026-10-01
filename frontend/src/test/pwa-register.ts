/** Unit-test-only substitute for Vite PWA's generated virtual module. */
export function useRegisterSW() {
  return { needRefresh: [false] as const, updateServiceWorker: () => Promise.resolve() };
}
