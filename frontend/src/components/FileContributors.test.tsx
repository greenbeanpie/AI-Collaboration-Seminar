import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContributorNames, FileContributorPicker } from './FileContributors';
import { api } from '../api/client';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('defaults to me and supports full, empty and partial selection', async () => {
  vi.spyOn(api,'get').mockImplementation((async (path: string) => path.endsWith('/me') ? {userId:'a'} : {items:[{userId:'a',displayName:'Alice'},{userId:'b',displayName:'Bob'}]}) as typeof api.get);
  const onChange=vi.fn(); const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const ui=(value?:string[]) => <QueryClientProvider client={client}><FileContributorPicker projectId="project" value={value} onChange={onChange} /></QueryClientProvider>;
  const view=render(ui());
  expect(await screen.findByLabelText('Alice')).toBeChecked();
  expect(screen.getByLabelText('Bob')).not.toBeChecked();
  expect((screen.getByLabelText('全选已载入组员') as HTMLInputElement).indeterminate).toBe(true);
  fireEvent.click(screen.getByLabelText('全选已载入组员'));expect(onChange).toHaveBeenLastCalledWith(['a','b']);
  view.rerender(ui(['a','b']));fireEvent.click(screen.getByLabelText('全选已载入组员'));expect(onChange).toHaveBeenLastCalledWith([]);
  view.rerender(ui([]));expect(screen.getByRole('alert')).toHaveTextContent('请至少选择');
  vi.restoreAllMocks();
});
it('shows unmarked history and retained snapshot names', () => {
  const view=render(<ContributorNames />);expect(screen.getByText('贡献归属：未标记')).toBeInTheDocument();
  view.rerender(<ContributorNames contributors={[{userId:'a',displayName:'Alice'}]} />);expect(screen.getByText('贡献归属：Alice')).toBeInTheDocument();
});
it('reuses the same member array cache as team and task pages',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
  client.setQueryData(['members','cached', 'pages', {}, ''],{ pages: [{ items: [{userId:'a',displayName:'Cached Alice'},{userId:'b',displayName:'Cached Bob'}], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['member','cached','me'],{userId:'a'});
  render(<QueryClientProvider client={client}><FileContributorPicker projectId="cached" onChange={()=>{}} value={undefined}/></QueryClientProvider>);
  expect(screen.getByLabelText('Cached Alice')).toBeChecked();
  expect(screen.getByLabelText('Cached Bob')).not.toBeChecked();
  expect(client.getQueryData(['members','cached', 'pages', {}, ''])).toMatchObject({ pages: [{ items: expect.any(Array) }] });
});
it('preserves selected contributors outside the current server search page', async () => {
  vi.spyOn(api, 'get').mockImplementation((async (path: string, query?: { q?: string; cursor?: string }) => path.endsWith('/me') ? { userId: 'a' } : query?.q ? { items: [{ userId: 'b', displayName: 'Bob' }], nextCursor: null } : { items: [{ userId: 'a', displayName: 'Alice' }], nextCursor: 'next' }) as typeof api.get);
  const onChange = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><FileContributorPicker projectId="search" value={['a']} onChange={onChange} /></QueryClientProvider>);
  await screen.findByLabelText('Alice'); fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Bob' } });
  fireEvent.click(await screen.findByLabelText('Bob')); expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
  expect(screen.getByRole('status')).toHaveTextContent('选择已保留');
  vi.restoreAllMocks();
});
