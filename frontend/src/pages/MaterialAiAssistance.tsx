import { Suspense, useId, useState } from 'react';
import { resilientLazy } from '../resilient-lazy';
import { Spinner } from '../components/ui';
import './MaterialAiAssistance.css';

const AiWorkspacePage = resilientLazy(() => import('./AiWorkspacePage').then(module => ({ default: module.AiWorkspacePage })));

/** Collapsing keeps instructions and any in-progress workflow mounted. */
export function MaterialAiAssistance({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const panelId = useId();
  const [opened, setOpened] = useState(initiallyOpen);
  const [visited, setVisited] = useState(initiallyOpen);
  return <section className={`material-ai-assistance${opened ? ' is-open' : ''}`} aria-label="成果 AI 协作">
    <button type="button" className="button button-quiet button-small" aria-expanded={opened} aria-controls={panelId} onClick={() => { setVisited(true); setOpened(value => !value); }}>{opened ? '收起 AI 协助' : '打开 AI 协助'}</button>
    <div id={panelId} hidden={!opened} className="material-ai-assistance-content">{visited && <Suspense fallback={<Spinner label="正在打开成果 AI 协作" />}><AiWorkspacePage embedded /></Suspense>}</div>
  </section>;
}
