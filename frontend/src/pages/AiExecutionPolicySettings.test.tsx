import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiExecutionPolicySettings } from './AiExecutionPolicySettings';
const transport = vi.hoisted(() => vi.fn());
vi.mock('../auth', () => ({ adminRequest: transport }));
vi.mock('./settings-dirty', () => ({ useSettingsDirty: vi.fn() }));
afterEach(cleanup); beforeEach(() => transport.mockReset());
it('loads independent policy and saves using its expected version', async () => {
 transport.mockResolvedValueOnce({ version: 8, maxModelCalls: 100 }).mockResolvedValueOnce({ version: 9, maxModelCalls: 200 });
 render(<AiExecutionPolicySettings access token="" />);
 const input = await screen.findByRole('spinbutton'); await waitFor(() => expect(input).toBeEnabled()); fireEvent.change(input, { target: { value: '200' } }); fireEvent.click(screen.getByRole('button', { name: '保存执行策略' }));
 await screen.findByText('执行策略已保存，将在新处理窗口生效。'); expect(transport).toHaveBeenLastCalledWith('/api/v1/admin/ai-execution-policy', { method: 'PUT', token: '', body: { expectedVersion: 8, maxModelCalls: 200 } });
});
it('rejects fractional and out of range limits without saving', async () => {
 transport.mockResolvedValue({ version: 8, maxModelCalls: 100 }); render(<AiExecutionPolicySettings access token="" />); const input = screen.getByRole('spinbutton'); await waitFor(() => expect(input).toBeEnabled()); fireEvent.change(input, { target: { value: '10001' } }); fireEvent.click(screen.getByRole('button', { name: '保存执行策略' })); await screen.findByText('调用上限需要是 1–10000 的整数。'); expect(transport).toHaveBeenCalledTimes(1);
});
it('does not load policy for unauthorized users', () => { render(<AiExecutionPolicySettings access={false} token="" />); expect(transport).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '保存执行策略' })).toBeDisabled(); });
