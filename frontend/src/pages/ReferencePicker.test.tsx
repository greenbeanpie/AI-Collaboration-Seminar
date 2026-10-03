import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReferencePicker, type ReferenceSelection } from './ReferencePicker';
vi.mock('./FixedMaterialVersions', () => ({ FixedMaterialVersions: () => <p>材料版本</p> }));
afterEach(cleanup);
it('returns from its independent page with selections and parent draft intact, preserving historical source versions', () => {
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
  client.setQueryData(['project-assistant-sources','p'],[{sourceId:'source',title:'通知',currentVersionId:'new'}]);
  function Harness(){const [selection,setSelection]=useState<ReferenceSelection>({sourceVersionIds:['old'],materialVersionIds:[]});return <><input aria-label="目标草稿" defaultValue="保留我的目标"/><ReferencePicker projectId="p" {...selection} onChange={setSelection}/><p>{selection.sourceVersionIds.join(',')}</p></>;}
  render(<QueryClientProvider client={client}><MemoryRouter><Harness/></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:'选择优先参考文件'}));
  expect(screen.getByRole('dialog',{name:'选择优先参考文件'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/固定来源 old/})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox',{name:'通知'}));
  fireEvent.click(screen.getByRole('button',{name:'完成选择并返回'}));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('目标草稿')).toHaveValue('保留我的目标');
  expect(screen.getByText('old,new')).toBeInTheDocument();
});
