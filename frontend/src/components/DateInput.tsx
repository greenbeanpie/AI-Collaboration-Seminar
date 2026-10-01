import { useState, type InputHTMLAttributes } from 'react';

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> & {
  type?: 'date' | 'datetime-local';
  value: string;
};

/** Keep the native picker, keyboard editing and ISO value; only change its empty display. */
export function DateInput({ type = 'date', value, onKeyDown, onPointerDown, onBlur, ...props }: DateInputProps) {
  const [keyboardEditing, setKeyboardEditing] = useState(false);
  return <span className="date-input-control" data-empty={value === ''} data-keyboard-editing={keyboardEditing}>
    <input {...props} type={type} value={value}
      onKeyDown={event => {
        // Explicit keyboard editing reveals partial native segments; pointer focus stays blank.
        if (/^[0-9]$/.test(event.key) || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'].includes(event.key)) setKeyboardEditing(true);
        onKeyDown?.(event);
      }}
      onPointerDown={event => { setKeyboardEditing(false); onPointerDown?.(event); }}
      onBlur={event => { setKeyboardEditing(false); onBlur?.(event); }} />
    <span className="date-input-placeholder" aria-hidden="true" data-placeholder="请选择日期" />
  </span>;
}
