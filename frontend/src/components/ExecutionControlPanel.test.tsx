import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExecutionControlPanel } from './ExecutionControlPanel';
import type { ExecutionView } from '../api/ai-execution';
const transport = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async () => ({ ...await vi.importActual('../api/client'), request: transport }));
const paused: ExecutionView = { generation: 4, windowCalls: 100, totalCalls: 200, limit: 100, state: 'paused', pauseReason: 'round_limit', canContinue: true, canOutput: true };
afterEach(cleanup); beforeEach(() => { transport.mockReset(); sessionStorage.clear(); });
it('continues the same execution generation with one idempotent request despite double clicks', async () => {
 let resolve!: (value: unknown) => void;
 transport.mockImplementation(() => new Promise(done => { resolve = done; }));
 const updated = vi.fn(); render(<ExecutionControlPanel execution={paused} path="/api/v1/jobs/a" onUpdated={updated} />);
 expect(screen.getByRole('status').textContent).toContain('累计 200 轮');
 const button = screen.getByRole('button', { name: '继续处理' }); fireEvent.click(button); fireEvent.click(button);
 await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
 expect(transport).toHaveBeenCalledWith('/api/v1/jobs/a/execution/continue', expect.objectContaining({ body: { expectedGeneration: 4 }, idempotencyKey: expect.any(String), networkOnly: true }));
 resolve({ execution: { ...paused, generation: 5, state: 'running' } });
 await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
});
it('ignores a delayed action response after a newer generation becomes visible', async () => {
 let resolve!: (value: unknown) => void; transport.mockImplementation(() => new Promise(done => { resolve = done; }));
 const updated = vi.fn(); const props = { path: '/api/v1/creation-drafts/a', onUpdated: updated };
 const view = render(<ExecutionControlPanel {...props} execution={paused} />); fireEvent.click(screen.getByRole('button', { name: '输出当前结果' }));
 await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
 view.rerender(<ExecutionControlPanel {...props} execution={{ ...paused, generation: 6 }} />);
 resolve({ execution: { ...paused, generation: 5 } }); await waitFor(() => expect(screen.queryByText('正在更新处理状态…')).not.toBeInTheDocument()); expect(updated).not.toHaveBeenCalled();
});
it('permits cancelling a running window and hides continue and output unless allowed', async () => {
 transport.mockResolvedValue({ execution: { ...paused, state: 'cancelled' } });
 render(<ExecutionControlPanel execution={{ ...paused, windowCalls: 1, state: 'running', canContinue: false, canOutput: false }} path="/api/v1/jobs/a" onUpdated={vi.fn()} />);
 expect(screen.queryByRole('button', { name: '继续处理' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '取消处理' }));
 await waitFor(() => expect(transport).toHaveBeenCalledWith('/api/v1/jobs/a/execution/cancel', expect.anything()));
});
it('requires an explicit user action to allow replay after an unknown response', async () => {
 transport.mockResolvedValue({ execution: { ...paused, generation: 5, state: 'running' } });
 render(<ExecutionControlPanel execution={{ ...paused, pauseReason: 'request_uncertain' }} path="/api/v1/jobs/a" onUpdated={vi.fn()} />);
 expect(screen.getByText(/点击继续或输出将允许重新请求/)).toBeInTheDocument(); expect(transport).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: '继续处理' }));
 await waitFor(() => expect(transport).toHaveBeenCalledWith('/api/v1/jobs/a/execution/continue', expect.objectContaining({ body: { expectedGeneration: 4, allowUncertainDispatch: true } })));
});
