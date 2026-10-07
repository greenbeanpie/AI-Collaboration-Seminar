import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VirtualList } from './VirtualList';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const items = Array.from({ length: 160 }, (_, index) => ({ id: String(index), title: `任务 ${index}` }));
const show = (rows = items) => render(<VirtualList label="任务列表" items={rows} getKey={row => row.id} renderItem={row => <button>{row.title}</button>} />);
it('keeps short lists fully mounted', () => { show(items.slice(0, 100)); expect(screen.getAllByRole('button')).toHaveLength(100); });
it('windows long lists and keyboard End reaches the final row', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  show(); expect(screen.getAllByRole('button').length).toBeLessThan(20);
  fireEvent.keyDown(screen.getByRole('list'), { key: 'End' });
  await waitFor(() => expect(screen.getByRole('button', { name: '任务 159' })).toBeInTheDocument());
  expect(screen.getByRole('button', { name: '任务 159' }).parentElement).toHaveAttribute('aria-posinset', '160');
  fireEvent.keyDown(screen.getByRole('button', { name: '任务 159' }).parentElement!, { key: 'Home' });
  await waitFor(() => expect(screen.getByRole('button', { name: '任务 0' })).toBeInTheDocument());
});
it('measures changed row heights without an estimate overlap', async () => {
  const observed: Element[] = [];
  let notify: ResizeObserverCallback | undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe(element: Element) { observed.push(element); }
    disconnect() {}
  });
  show();
  const first = observed.find(element => element.getAttribute('data-virtual-key') === '0')!;
  const { act } = await import('@testing-library/react');
  act(() => notify!([{ target: first, contentRect: { height: 320 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(screen.getByRole('button', { name: '任务 1' }).parentElement).toHaveStyle({ top: '320px' });
});
