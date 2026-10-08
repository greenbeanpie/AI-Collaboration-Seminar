import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceErrorBoundary } from './WorkspaceErrorBoundary';

describe('friendly error boundary',()=>{
  it('shows only the original failure reason and recovery controls',()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    function Broken():never { throw Object.assign(new Error('render regression'), {code:'INTERNAL',requestId:'private-id'}); }
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><WorkspaceErrorBoundary><Broken/></WorkspaceErrorBoundary></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText('render regression')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).not.toContain('INTERNAL');
    expect(screen.getByRole('alert').textContent).not.toContain('private-id');
    expect(screen.queryByText('查看错误详情')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
