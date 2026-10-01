import './dialogs.css';
import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './Modal';
import type { DialogOptions, DialogResult } from './dialog-service';

export function PageDialog({ options, onFinish }: { options: DialogOptions; onFinish: (result: DialogResult) => void }) {
  const [value, setValue] = useState(options.initialValue ?? '');
  const input = useRef<HTMLInputElement>(null); const cancelButton = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const cancel = () => onFinish(options.kind === 'prompt' ? null : false);
  useEffect(() => {
    if (input.current) { input.current.focus(); input.current.select(); }
    else cancelButton.current?.focus();
  }, []);
  return <Modal title={options.title ?? (options.kind === 'prompt' ? '输入内容' : options.kind === 'alert' ? '提示' : '确认操作')} descriptionId={descriptionId} onClose={cancel}>
    <form onSubmit={event => { event.preventDefault(); onFinish(options.kind === 'prompt' ? value : true); }} aria-describedby={descriptionId}>
      <p id={descriptionId} className="page-dialog-message">{options.message}</p>
      {options.kind === 'prompt' && <label className="field"><span>输入内容</span><input ref={input} className="input" value={value} onChange={event => setValue(event.target.value)} aria-describedby={descriptionId}/></label>}
      <div className="form-actions">
        {options.kind !== 'alert' && <button ref={cancelButton} type="button" className="button button-quiet" onClick={cancel}>{options.cancelLabel ?? '取消'}</button>}
        <button type="submit" className="button button-primary">{options.confirmLabel ?? '确定'}</button>
      </div>
    </form>
  </Modal>;
}
