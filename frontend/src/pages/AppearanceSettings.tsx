import { useState } from 'react';
import { useAiReferencePreferences } from '../ai-reference-preferences';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { ThemeSelector } from '../components/ThemeSelector';

export function AppearanceSettings() {
  const { visible, setVisible } = useAiReferencePreferences();
  const [saved, setSaved] = useState(true);
  return <div className="stack">
    <ThemeSelector variant="field" />
    <section className="card section-card">
      <h2>AI 内容引用标识</h2>
      <label className="checkbox-row"><input type="checkbox" checked={visible} onChange={event => setSaved(setVisible(event.target.checked))} /><span>显示 AI 内容引用标识</span></label>
      <p className="muted">在项目中可供 AI 引用的内容旁显示蓝色标识。此显示偏好按当前账户保存在本浏览器，关闭后仍保留原有 AI 使用权限。</p>
      {visible && <p>标识预览：<AiReferenceBadge /></p>}
      {!saved && <p role="status">已在当前页面生效，但浏览器未能保存此偏好。</p>}
    </section>
  </div>;
}
