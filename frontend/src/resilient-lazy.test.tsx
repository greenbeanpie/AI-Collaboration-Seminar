import { Suspense } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { isAssetLoadError, resilientLazy } from './resilient-lazy';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('keeps the shell and edits when a lazy module is missing, with only explicit update requests', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const Page = resilientLazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/old.js')));
  const router = createMemoryRouter([{ path: '*', element: <><input aria-label="existing edit" defaultValue="UNSAVED" /><Suspense fallback={<p>Loading</p>}><Page /></Suspense></> }]);
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: '页面资源暂时不可用' });
  expect(screen.getByLabelText('existing edit')).toHaveValue('UNSAVED');
  expect(dispatch.mock.calls.map(([event]) => event.type)).toContain('app-assets-unavailable');
  expect(dispatch.mock.calls.map(([event]) => event.type)).not.toContain('app-update-request');
  fireEvent.click(screen.getByRole('button', { name: '检查并确认更新' }));
  expect(dispatch.mock.calls.map(([event]) => event.type)).toContain('app-update-request');
  expect(screen.getByLabelText('existing edit')).toHaveValue('UNSAVED');
});
it('limits recovery to resource-loading errors', () => {
  expect(isAssetLoadError(new Error('Unable to preload CSS for /assets/old.css'))).toBe(true);
  expect(isAssetLoadError(new Error('Importing a module script failed.'))).toBe(true);
  expect(isAssetLoadError(new Error('Programming error'))).toBe(false);
  expect(isAssetLoadError('private error payload')).toBe(false);
});
