import { errorMessage } from '../api/error-info';
import { usePageDialogs } from '../dialogs/usePageDialogs';
import { useRef, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle } from 'lucide-react';
import { AiReferenceBadge } from './AiReferenceBadge';

export function Spinner({ label = '正在加载' }: { label?: string }) {
  return <div className="loading"><LoaderCircle className="spin" size={18} aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = errorMessage(error);
  return (
    <div className="notice notice-error" role="alert">
      <AlertCircle size={19} aria-hidden="true" />
      <div className="notice-copy">
        <strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message}</strong>
      </div>
      {onRetry && <button className="button button-quiet button-small" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-dot">✳</div><h3>{title}</h3>{detail && <p>{detail}</p>}{action}</div>;
}

export function PageHeading({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

export function SectionCard({ title, detail, action, children, className = '', aiReference = false }: { title: string; detail?: string; action?: ReactNode; children: ReactNode; className?: string; aiReference?: boolean }) {
  return <section className={`card section-card ${className}`}><div className="section-head"><div><h2>{title}{aiReference && <AiReferenceBadge ariaHidden />}</h2>{detail && <p>{detail}</p>}</div>{action}</div>{children}</section>;
}

export { Modal } from '../dialogs/Modal';

export function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-link" href={href}>{children}<ArrowRight size={14} aria-hidden="true" /></a>;
}

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'blue' }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

export function Field({ label, hint, children, aiReference = false }: { label: string; hint?: string; children: ReactNode; aiReference?: boolean }) {
  return <label className="field"><span className="field-label">{label}{aiReference && <AiReferenceBadge ariaHidden />}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function ConfirmButton({ children, onClick, disabled, className = 'button button-danger', 'aria-label': ariaLabel }: { children: ReactNode; onClick: () => void; disabled?: boolean; className?: string; 'aria-label'?: string }) {
  const dialogs = usePageDialogs(ariaLabel ?? '');
  const pending = useRef(false);
  const latestDisabled = useRef(disabled); latestDisabled.current = disabled;
  return <button type="button" className={className} aria-label={ariaLabel} disabled={disabled} onClick={async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    try { if (await dialogs.confirm('请确认此操作。') && !latestDisabled.current) onClick(); }
    finally { pending.current = false; }
  }}>{children}</button>;
}
