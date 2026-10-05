import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceErrorBoundary } from './WorkspaceErrorBoundary';
import { errorDiagnostics, sanitizeDiagnostic } from './error-diagnostics';

describe('friendly error boundary',()=>{
  it('redacts quoted credentials and full cookie headers',()=>{
    const text=sanitizeDiagnostic('"password":"private password"\nCookie: session=private; other=secret\nAuthorization: Bearer api-secret');
    expect(text).not.toContain('private');expect(text).not.toContain('api-secret');expect(text).not.toContain('other=secret');
  });
  it('keeps error stack and request ID while removing URL parameters and secrets',()=>{
    const error=Object.assign(new Error('failure https://example.com/path?token=private Bearer secret'),{requestId:'request-123',code:'INTERNAL'});
    const result=errorDiagnostics(error,'at Team');
    expect(result).toContain('request-123');expect(result).toContain('at Team');expect(result).toContain('Error: failure');
    expect(result).not.toContain('private');expect(result).not.toContain('Bearer secret');
  });
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
