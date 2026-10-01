import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { confirmPage, promptPage, cancelPageDialog } from './dialog-service';
import { usePageDialogs } from './usePageDialogs';
import { Modal } from './Modal';

afterEach(async () => { await act(async () => { cancelPageDialog(); }); cleanup(); vi.restoreAllMocks(); });
async function answer(name: '确定' | '取消') { const dialog = await screen.findByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); }
it('waits for an explicit decision and rejects overlapping decisions without approving either', async () => {
 let done = false; let first!: Promise<boolean>;
 await act(async () => { first = confirmPage('真正执行之前请确认'); }); void first.then(() => { done = true; });
 expect(done).toBe(false); expect(await confirmPage('第二个操作')).toBe(false);
 await answer('取消'); expect(await first).toBe(false);
 let accepted!: Promise<boolean>; await act(async () => { accepted = confirmPage('再次确认'); }); await answer('确定'); expect(await accepted).toBe(true);
});
it('Escape and Back cancel, and cancellation restores the original focused trigger', async () => {
 const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
 let result!: Promise<boolean>; await act(async () => { result = confirmPage('保留当前草稿'); });
 fireEvent.keyDown(document, {key:'Escape'}); expect(await result).toBe(false); expect(document.activeElement).toBe(trigger);
 await act(async () => { result = confirmPage('返回不执行'); }); await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); }); expect(await result).toBe(false);
 trigger.remove();
});
it('prompt preserves default/edit/empty values and returns null only for cancellation', async () => {
 let result!: Promise<string|null>; await act(async () => { result = promptPage('输入链接','https://example.test'); });
 expect(screen.getByRole('textbox')).toHaveValue('https://example.test'); fireEvent.change(screen.getByRole('textbox'),{target:{value:'https://changed.test'}}); await answer('取消'); expect(await result).toBeNull();
 await act(async () => { result = promptPage('输入链接','https://example.test'); }); fireEvent.change(screen.getByRole('textbox'),{target:{value:''}}); await answer('确定'); expect(await result).toBe('');
});
it('unmounting the origin cancels pending actions without executing them', async () => {
 const action = vi.fn();
 function Origin(){const dialogs=usePageDialogs('record-one');return <button onClick={async()=>{if(await dialogs.confirm('确认删除'))action();}}>删除</button>;}
 const view=render(<Origin/>); fireEvent.click(screen.getByRole('button',{name:'删除'})); await screen.findByRole('dialog');
 await act(async()=>view.unmount()); expect(action).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
});
it('Escape closes a nested decision without dismissing the underlying editor', async()=>{
 const close=vi.fn();render(<Modal title="编辑中的草稿" onClose={close}><input aria-label="草稿" defaultValue="保留"/></Modal>);
 let result!:Promise<boolean>;await act(async()=>{result=confirmPage('是否放弃？');});
 expect(screen.getAllByRole('dialog')).toHaveLength(2);fireEvent.keyDown(document,{key:'Escape'});expect(await result).toBe(false);
 expect(close).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'编辑中的草稿'})).toBeInTheDocument();expect(screen.getByLabelText('草稿')).toHaveValue('保留');
});
it('unmounting an editor with a nested decision restores page scrolling after both close',async()=>{
 document.body.style.overflow='auto';
 function Editor(){const dialogs=usePageDialogs('editor');return <Modal title="编辑器" onClose={()=>undefined}><button onClick={()=>void dialogs.confirm('丢弃草稿？')}>取消编辑</button></Modal>;}
 const view=render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));await waitFor(()=>expect(screen.getAllByRole('dialog')).toHaveLength(2));
 await act(async()=>view.unmount());expect(screen.queryByRole('dialog')).toBeNull();expect(document.body.style.overflow).toBe('auto');document.body.style.overflow='';
});
