import './notifications/notifications.css';
import './dialogs/dialog-service';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { RouteErrorPage } from './components/WorkspaceErrorBoundary';
import './styles/app.css';
import './styles/theme.css';
import './styles/readability.css';
import { setDesktopAccount, startDesktopLifecycle } from './desktop/lifecycle';
import { offlineAccount } from './offline/store';
import { createSnapshotInvalidationScheduler } from './api/snapshot-invalidation';

setDesktopAccount(offlineAccount()?.id ?? null);
startDesktopLifecycle();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      staleTime: 8_000,
      retry: (failureCount, error) => {
        if (failureCount >= 1) return false;
        return !(error instanceof Error && 'status' in error && (error as { status?: number }).status === 401);
      },
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false, networkMode: 'always' },
  },
});

const router = createBrowserRouter([{ path: '*', element: <App />, errorElement: <RouteErrorPage /> }]);

// Re-run active queries against the updated snapshots without replacing the page.
const snapshotInvalidator = createSnapshotInvalidationScheduler(queryClient, () => offlineAccount()?.id, 50);
window.addEventListener('offline-snapshot-updated', event => {
  snapshotInvalidator.schedule((event as CustomEvent<{ accountId?: string; url?: string }>).detail);
});
window.addEventListener('project-access-revoked', event => {
  const { accountId, projectId } = (event as CustomEvent<{ accountId: string; projectId: string }>).detail;
  if (offlineAccount()?.id !== accountId) return;
  void queryClient.cancelQueries({ predicate: query => query.queryKey[1] === projectId && query.queryKey[0] !== 'project' });
  queryClient.removeQueries({ predicate: query => query.queryKey[1] === projectId && query.queryKey[0] !== 'project' });
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
});
window.addEventListener('project-permissions-updated', event => {
  const { accountId, projectId } = (event as CustomEvent<{ accountId: string; projectId: string }>).detail;
  if (offlineAccount()?.id === accountId) void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
