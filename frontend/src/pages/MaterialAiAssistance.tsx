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
  return <section className="material-ai-assistance" aria-label="成果 AI 协作">
    <div className="material-ai-assistance-heading"><div><h2>AI 协助成果</h2><p>围绕任务、来源与材料生成草稿或审阅意见，复核后再采纳为成果版本。</p></div><button type="button" className="button button-quiet" aria-expanded={opened} aria-controls={panelId} onClick={() => { setVisited(true); setOpened(value => !value); }}>{opened ? '收起 AI 协助' : '打开 AI 协助'}</button></div>
    <div id={panelId} hidden={!opened} className="material-ai-assistance-content">{visited && <Suspense fallback={<Spinner label="正在打开成果 AI 协作" />}><AiWorkspacePage embedded /></Suspense>}</div>
  </section>;
}
