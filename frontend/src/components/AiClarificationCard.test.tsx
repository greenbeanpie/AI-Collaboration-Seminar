import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { AiClarification } from '../api/clarifications';
import { AiClarificationCard } from './AiClarificationCard';

const question: AiClarification = { id: 'question-1', question: '本次交付面向谁？', reason: '不同受众影响验收标准', options: ['校内评委', '社会公众'], allowUndecided: true, round: 1, maxRounds: 3, status: 'pending', revision: 2, createdAt: '2026-10-03T08:00:00Z' };
afterEach(cleanup);
function setup(overrides: Partial<Parameters<typeof AiClarificationCard>[0]> = {}) {
  const props = { question, onAnswer: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined), ...overrides };
  return { ...render(<AiClarificationCard {...props} />), props };
}
describe('AI clarification input', () => {
  it('requires an explicit answer and submits one selected option with an accessible label', async () => {
    const { props } = setup();
    expect(screen.getByRole('button', { name: '提交回答并继续' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'AI 需要你补充信息' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '校内评委' }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await waitFor(() => expect(props.onAnswer).toHaveBeenCalledWith({ option: '校内评委' }));
  });
  it('keeps free text after a network failure and guards duplicate clicks during retry', async () => {
    let finish!: () => void;
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error('网络断开，回答尚未确认')).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    setup({ onAnswer });
    fireEvent.change(screen.getByLabelText('补充回答'), { target: { value: '  面向社区志愿者  ' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await screen.findByText('网络断开，回答尚未确认');
    expect(screen.getByLabelText('补充回答')).toHaveValue('  面向社区志愿者  ');
    const button = screen.getByRole('button', { name: '提交回答并继续' });
    fireEvent.click(button); fireEvent.click(button);
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith({ text: '面向社区志愿者' });
    expect(screen.getByRole('button', { name: '取消本次 AI 操作' })).toBeDisabled();
    await act(async () => finish());
  });
  it('sends undecided only when explicitly offered and clicked', async () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: '尚未决定，先保留未决范围' }));
    await waitFor(() => expect(props.onAnswer).toHaveBeenCalledWith({ undecided: true }));
    rerender(<AiClarificationCard {...props} question={{ ...question, allowUndecided: false }} />);
    expect(screen.queryByRole('button', { name: '尚未决定，先保留未决范围' })).not.toBeInTheDocument();
  });
  it('refetches stale questions and retains input for review after conflict', async () => {
    const conflict = new ApiError(409, { requestId: 'conflict', error: { code: 'REVISION_CONFLICT', message: '版本已更新', retryable: false } });
    const { props } = setup({ onAnswer: vi.fn().mockRejectedValue(conflict) });
    fireEvent.change(screen.getByLabelText('补充回答'), { target: { value: '暂存的回答' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('补充回答')).toHaveValue('暂存的回答');
    expect(screen.getByText(/问题状态已更新，已重新读取/)).toBeInTheDocument();
  });
  it('cancels without submitting an answer and preserves inputs on cancellation error', async () => {
    const { props } = setup({ onCancel: vi.fn().mockRejectedValueOnce(new Error('取消未确认')).mockResolvedValueOnce(undefined) });
    fireEvent.click(screen.getByRole('radio', { name: '社会公众' }));
    fireEvent.click(screen.getByRole('button', { name: '取消本次 AI 操作' }));
    await screen.findByText('取消未确认');
    expect(screen.getByRole('radio', { name: '社会公众' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '取消本次 AI 操作' }));
    await waitFor(() => expect(props.onCancel).toHaveBeenCalledTimes(2));
    expect(props.onAnswer).not.toHaveBeenCalled();
  });
  it('clears an old answer when the server asks the next question', () => {
    const { props, rerender } = setup();
    fireEvent.change(screen.getByLabelText('补充回答'), { target: { value: '第一轮回答' } });
    rerender(<AiClarificationCard {...props} question={{ ...question, id: 'question-2', round: 2, question: '下一步的限制是什么？' }} />);
    expect(screen.getByLabelText('补充回答')).toHaveValue('');
    expect(screen.getByText('第 2 / 3 轮')).toBeInTheDocument();
  });
});
