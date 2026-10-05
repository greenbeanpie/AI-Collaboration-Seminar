import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnstileChallenge } from './TurnstileChallenge';

afterEach(() => {
  cleanup(); delete window.turnstile;
  document.querySelectorAll('script[src^="https://challenges.cloudflare.com/turnstile/"]').forEach(script => script.remove());
});
it('StrictMode 只保留一个验证实例，过期和超时清除令牌并提示', async () => {
  const onToken = vi.fn(); const onError = vi.fn();
  const renderWidget = vi.fn<NonNullable<typeof window.turnstile>['render']>(() => 'fixture-widget');
  const remove = vi.fn(); window.turnstile = { render: renderWidget, remove };
  const view = render(<StrictMode><TurnstileChallenge siteKey="fixture-site" reset={0} onToken={onToken} onError={onError} /></StrictMode>);
  await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1));
  const callbacks = renderWidget.mock.calls[0]![1];
  act(() => callbacks.callback('fixture-token'));
  expect(onToken).toHaveBeenLastCalledWith('fixture-token');
  act(() => callbacks['expired-callback']());
  expect(onToken).toHaveBeenLastCalledWith('');
  expect(onError).toHaveBeenLastCalledWith('安全验证已过期，请重新验证');
  act(() => callbacks['timeout-callback']());
  expect(onToken).toHaveBeenLastCalledWith('');
  expect(onError).toHaveBeenLastCalledWith('安全验证超时，请重试；若仍失败，请检查浏览器与网络');
  view.unmount(); expect(remove).toHaveBeenCalledOnce();
});
it('重试会清理旧实例，错误提示不展示技术错误码', async () => {
  const onToken = vi.fn(); const onError = vi.fn(); const remove = vi.fn();
  const renderWidget = vi.fn<NonNullable<typeof window.turnstile>['render']>(() => 'widget');
  window.turnstile = { render: renderWidget, remove };
  const view = render(<TurnstileChallenge siteKey="fixture-site" reset={0} onToken={onToken} onError={onError} />);
  await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1));
  act(() => renderWidget.mock.calls[0]![1]['error-callback']('110200'));
  expect(onError).toHaveBeenLastCalledWith('安全验证失败，请重试或使用系统浏览器');
  view.rerender(<TurnstileChallenge siteKey="fixture-site" reset={1} onToken={onToken} onError={onError} />);
  await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(2));
  expect(remove).toHaveBeenCalledTimes(1);
});
it('SDK 网络加载失败明确显示错误且允许重新加载', async () => {
  const onToken = vi.fn(); const onError = vi.fn();
  const view = render(<TurnstileChallenge siteKey="fixture-site" reset={0} onToken={onToken} onError={onError} />);
  const first = document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]')!;
  fireEvent.error(first);
  await waitFor(() => expect(onError).toHaveBeenCalledWith('无法加载安全验证，请检查网络'));
  view.rerender(<TurnstileChallenge siteKey="fixture-site" reset={1} onToken={onToken} onError={onError} />);
  expect(document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]')).not.toBe(first);
});
