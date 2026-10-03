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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
