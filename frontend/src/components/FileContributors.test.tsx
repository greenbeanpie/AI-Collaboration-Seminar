import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ContributorNames, FileContributorPicker } from './FileContributors';
import { api } from '../api/client';
it('defaults to me and supports full, empty and partial selection', async () => {
  vi.spyOn(api,'get').mockImplementation((async (path: string) => path.endsWith('/me') ? {userId:'a'} : {items:[{userId:'a',displayName:'Alice'},{userId:'b',displayName:'Bob'}]}) as typeof api.get);
  const onChange=vi.fn(); const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const ui=(value?:string[]) => <QueryClientProvider client={client}><FileContributorPicker projectId="project" value={value} onChange={onChange} /></QueryClientProvider>;
  const view=render(ui());
  expect(await screen.findByLabelText('Alice')).toBeChecked();
  expect(screen.getByLabelText('Bob')).not.toBeChecked();
  expect((screen.getByLabelText('全选组员') as HTMLInputElement).indeterminate).toBe(true);
  fireEvent.click(screen.getByLabelText('全选组员'));expect(onChange).toHaveBeenLastCalledWith(['a','b']);
  view.rerender(ui(['a','b']));fireEvent.click(screen.getByLabelText('全选组员'));expect(onChange).toHaveBeenLastCalledWith([]);
  view.rerender(ui([]));expect(screen.getByRole('alert')).toHaveTextContent('请至少选择');
  vi.restoreAllMocks();
});
it('shows unmarked history and retained snapshot names', () => {
  const view=render(<ContributorNames />);expect(screen.getByText('贡献归属：未标记')).toBeInTheDocument();
  view.rerender(<ContributorNames contributors={[{userId:'a',displayName:'Alice'}]} />);expect(screen.getByText('贡献归属：Alice')).toBeInTheDocument();
});
