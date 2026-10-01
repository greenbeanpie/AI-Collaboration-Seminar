import type { InputHTMLAttributes } from 'react';

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> & {
  type?: 'date' | 'datetime-local';
  value: string;
};

/** Keep the native picker, keyboard editing and ISO value; only change its empty display. */
export function DateInput({ type = 'date', value, ...props }: DateInputProps) {
  return <span className="date-input-control" data-empty={value === ''}>
    <input {...props} type={type} value={value} />
    <span className="date-input-placeholder" aria-hidden="true" data-placeholder="请选择日期" />
  </span>;
}
