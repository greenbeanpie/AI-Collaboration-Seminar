import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import './styles/app.css';
import './styles/theme.css';
import './styles/readability.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 8_000,
      retry: (failureCount, error) => {
        if (failureCount >= 1) return false;
        return !(error instanceof Error && 'status' in error && (error as { status?: number }).status === 401);
      },
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

const router = createBrowserRouter([{ path: '*', element: <App /> }]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
