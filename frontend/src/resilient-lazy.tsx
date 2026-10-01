import { lazy } from 'react';
import { ResourceRecovery } from './components/ResourceRecovery';

export function isAssetLoadError(error: unknown): boolean {
  return error instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .+ failed/i.test(error.message);
}

// Resolve an asset failure locally instead of replacing the entire app/router with an error.
// Programming errors still propagate to the normal error handling.
export const resilientLazy: typeof lazy = loader => lazy(() => loader().catch(error => {
  if (!isAssetLoadError(error)) throw error;
  window.dispatchEvent(new Event('app-assets-unavailable'));
  return { default: ResourceRecovery } as unknown as Awaited<ReturnType<typeof loader>>;
}));
