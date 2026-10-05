import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AiReferenceBadge } from './AiReferenceBadge';
import { AiReferencePreferencesProvider } from './AiReferencePreferencesProvider';
import { aiReferencePreferenceKey } from '../ai-reference-preferences';
import { AppearanceSettings } from '../pages/AppearanceSettings';
import { Field } from './ui';
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function view(accountId = 'a') {
  return <AiReferencePreferencesProvider accountId={accountId}><AppearanceSettings /><Field aiReference label="任务说明"><textarea /></Field><AiReferenceBadge /></AiReferencePreferencesProvider>;
}
it('defaults to visible blue pills and preserves existing form names', () => {
  const { container } = render(view());
  expect(container.querySelectorAll('.ai-reference-badge')).toHaveLength(3);
  expect(screen.getByLabelText('任务说明', { exact: true })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '显示 AI 内容引用标识' })).toBeChecked();
});
it('hides all badges immediately, persists after remount and isolates accounts', () => {
  const { container, unmount } = render(view());
  fireEvent.click(screen.getByRole('checkbox', { name: '显示 AI 内容引用标识' }));
  expect(container.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(0);
  expect(localStorage.getItem(aiReferencePreferenceKey('a'))).toBe('hidden');
  unmount(); const second = render(view());
  expect(second.container.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(0);
  second.rerender(view('b'));
  expect(second.container.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(3);
  second.rerender(view('a'));
  expect(second.container.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(0);
});
it('responds to another tab changing this account preference', () => {
  const { container } = render(view());
  act(() => {
    localStorage.setItem(aiReferencePreferenceKey('a'), 'hidden');
    window.dispatchEvent(new StorageEvent('storage', { key: aiReferencePreferenceKey('a') }));
  });
  expect(container.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(0);
  act(() => {
    localStorage.setItem(aiReferencePreferenceKey('b'), 'hidden');
    window.dispatchEvent(new StorageEvent('storage', { key: aiReferencePreferenceKey('b') }));
  });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});
it('retains immediate control when browser preference persistence fails', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  const { container } = render(view('blocked-account'));
  fireEvent.click(screen.getByRole('checkbox'));
  expect(container.querySelectorAll('[data-ai-reference-badge]')).toHaveLength(0);
  expect(screen.getByRole('status')).toHaveTextContent('浏览器未能保存此偏好');
});
