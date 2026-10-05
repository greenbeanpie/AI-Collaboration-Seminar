import { useAiReferencePreferences } from '../ai-reference-preferences';
import './AiReferenceBadge.css';

export function AiReferenceBadge({ ariaHidden = false }: { ariaHidden?: boolean }) {
  const { visible } = useAiReferencePreferences();
  if (!visible) return null;
  // Decorative labels use CSS text so form/heading names remain exactly unchanged.
  return <span className="ai-reference-badge" data-ai-reference-badge aria-hidden={ariaHidden || undefined} title="此处内容会被 AI 引用，作为项目分析、规划或评价的依据。">{!ariaHidden && 'AI 会引用'}</span>;
}
