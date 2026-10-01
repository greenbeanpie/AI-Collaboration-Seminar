import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DateInput } from './DateInput';
import { Field } from './ui';

afterEach(cleanup);

it('shows one empty hint without changing the accessible label, native type or required validation', () => {
  render(<Field label="截止日期"><DateInput value="" onChange={() => {}} required min="2026-01-01" max="2027-01-01" /></Field>);
  const input = screen.getByLabelText('截止日期') as HTMLInputElement;
  expect(input.type).toBe('date');
  expect(input.value).toBe('');
  expect(input.required).toBe(true);
  expect(input.validity.valueMissing).toBe(true);
  expect(input.min).toBe('2026-01-01');
  expect(input.max).toBe('2027-01-01');
  expect(input.parentElement).toHaveAttribute('data-empty', 'true');
  expect(input.nextElementSibling).toHaveAttribute('data-placeholder', '请选择日期');
  expect(input.nextElementSibling).toHaveAttribute('aria-hidden', 'true');
  expect(input).toHaveAccessibleName('截止日期');
  input.focus(); expect(input).toHaveFocus(); expect(input.type).toBe('date');
});

it('passes date values and clearing through unchanged', () => {
  const change = vi.fn();
  const view = render(<DateInput aria-label="日期" value="2026-10-01" onChange={event => change(event.target.value)} />);
  const input = screen.getByLabelText('日期') as HTMLInputElement;
  expect(input.parentElement).toHaveAttribute('data-empty', 'false');
  fireEvent.change(input, { target: { value: '2026-11-23' } });
  expect(change).toHaveBeenLastCalledWith('2026-11-23');
  fireEvent.change(input, { target: { value: '' } });
  expect(change).toHaveBeenLastCalledWith('');
  view.rerender(<DateInput aria-label="日期" value="" onChange={() => {}} />);
  expect(input.parentElement).toHaveAttribute('data-empty', 'true');
});

it('preserves datetime-local strings, disabled/read-only state and form attributes', () => {
  const { rerender } = render(<DateInput aria-label="决策时间" type="datetime-local" value="2026-10-01T09:50" disabled name="decision" id="decision" />);
  const input = screen.getByLabelText('决策时间') as HTMLInputElement;
  expect(input.type).toBe('datetime-local'); expect(input.value).toBe('2026-10-01T09:50');
  expect(input).toBeDisabled(); expect(input.name).toBe('decision'); expect(input.id).toBe('decision');
  rerender(<DateInput aria-label="决策时间" type="datetime-local" value="" readOnly />);
  expect(input.readOnly).toBe(true); expect(input.parentElement).toHaveAttribute('data-empty', 'true');
});
