import { afterEach, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
// @ts-expect-error The independently shipped update shell intentionally remains plain JavaScript.
import { requestPageDialog } from '../../public/in-page-dialog.js';
afterEach(()=>{window.dispatchEvent(new PopStateEvent('popstate'));});
it('standalone update-shell fallback renders an in-page dialog and cancellation preserves the page',async()=>{
 const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
 const decision=requestPageDialog({kind:'confirm',message:'先保存草稿。确认更新？'});const dialog=screen.getByRole('dialog');expect(dialog).toHaveTextContent('先保存草稿。确认更新？');
 fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));expect(await decision).toBe(false);expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(trigger);trigger.remove();
});
it('standalone fallback preserves prompt input and refuses concurrent implicit approval',async()=>{
 const first=requestPageDialog({kind:'prompt',message:'输入链接',initialValue:'https://'});expect(await requestPageDialog({kind:'confirm',message:'另一个操作'})).toBe(false);
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'https://example.test'}});fireEvent.click(screen.getByRole('button',{name:'确定'}));expect(await first).toBe('https://example.test');
});
it('standalone Escape and Back both cancel without taking the confirmed action',async()=>{
 let result=requestPageDialog({kind:'confirm',message:'退出？'});fireEvent.keyDown(document,{key:'Escape'});expect(await result).toBe(false);
 result=requestPageDialog({kind:'confirm',message:'重新加载？'});window.dispatchEvent(new PopStateEvent('popstate'));expect(await result).toBe(false);expect(screen.queryByRole('dialog')).toBeNull();
});
