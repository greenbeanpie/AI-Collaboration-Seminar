import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  it('renders Chinese recovery actions and lets the user select diagnostics when copying fails',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    function Broken():never { throw new Error('render regression'); }
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><WorkspaceErrorBoundary><Broken/></WorkspaceErrorBoundary></MemoryRouter></QueryClientProvider>);
    expect(screen.getByText('工作区暂时遇到问题')).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看错误详情'));fireEvent.click(screen.getByText('复制完整错误详情'));
    expect(await screen.findByText('复制失败，请在下方选中并手动复制错误详情。')).toBeInTheDocument();
    expect(screen.getByText(/render regression/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
