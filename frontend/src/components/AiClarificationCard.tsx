import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { AiClarification, ClarificationAnswer } from '../api/clarifications';
import { ErrorNotice, Field, StatusPill } from './ui';
import './AiClarificationCard.css';

type Props = {
  question: AiClarification;
  disabled?: boolean;
  onAnswer: (answer: ClarificationAnswer) => Promise<unknown>;
  onCancel: () => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
};

export function AiClarificationCard(props: Props) {
  return <ClarificationInput key={props.question.id} {...props} />;
}

function ClarificationInput({ question, disabled, onAnswer, onCancel, onRefresh }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const [option, setOption] = useState('');
  const [pending, setPending] = useState<'answer' | 'cancel' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const unavailable = disabled || pending !== null || question.status !== 'pending';
  const run = async (action: 'answer' | 'cancel', answer?: ClarificationAnswer) => {
    if (locked.current || unavailable) return;
    locked.current = true;
    setPending(action); setError(null); setStale(false);
    try {
      if (action === 'cancel') await onCancel();
      else if (answer) await onAnswer(answer);
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure);
      if (failure instanceof ApiError && [404, 409, 410].includes(failure.status)) {
        try { await onRefresh(); if (mounted.current) setStale(true); }
        catch (refreshError) { if (mounted.current) setError(refreshError); }
      }
    } finally {
      locked.current = false;
      if (mounted.current) setPending(null);
    }
  };
  return <section className="ai-clarification" aria-labelledby={`${id}-title`} aria-busy={pending !== null}>
    <div className="ai-clarification-heading"><h3 id={`${id}-title`}>AI 需要你补充信息</h3><StatusPill tone="warn">第 {question.round} / {question.maxRounds} 轮</StatusPill></div>
    <p className="form-note" role="status">等待你的回答，本次 AI 操作已暂停。回答后继续同一次任务。</p>
    <p className="ai-clarification-question">{question.question}</p>
    {question.reason && <p className="form-note">为什么需要：{question.reason}</p>}
    {question.options.length > 0 && <fieldset className="ai-clarification-options" disabled={unavailable}><legend>选择一个回答，或在下方自行填写</legend>{question.options.map((value, index) => <label key={`${index}-${value}`}><input type="radio" name={`${id}-option`} value={value} checked={option === value} onChange={() => { setOption(value); setText(''); }} /><span>{value}</span></label>)}</fieldset>}
    <Field label="补充回答"><textarea aria-label="补充回答" className="input" rows={3} maxLength={4000} value={text} disabled={unavailable} placeholder="填写你的实际情况或选择上方选项" onChange={event => { setText(event.target.value); setOption(''); }} /></Field>
    {stale && <p className="notice notice-warn">问题状态已更新，已重新读取。你的输入仍保留，请核对当前问题后再提交。</p>}
    {Boolean(error) && <ErrorNotice error={error} />}
    <div className="form-actions ai-clarification-actions">
      <button type="button" className="button button-primary" disabled={unavailable || (!option && !text.trim())} onClick={() => void run('answer', option ? { option } : { text: text.trim() })}>{pending === 'answer' ? '正在提交回答…' : '提交回答并继续'}</button>
      {question.allowUndecided && <button type="button" className="button button-quiet" disabled={unavailable} onClick={() => void run('answer', { undecided: true })}>尚未决定，先保留未决范围</button>}
      <button type="button" className="button button-quiet" disabled={unavailable} onClick={() => void run('cancel')}>{pending === 'cancel' ? '正在取消…' : '取消本次 AI 操作'}</button>
    </div>
  </section>;
}
