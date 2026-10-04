export type AudioPipelineInfo = {
  phase: string;
  qualityScore: number | null;
  reasons: string[];
  transcriptAvailable: boolean;
  canResumeFallback: boolean;
};
const phases: Record<string, string> = {
  cancelled:'任务已取消', pending: '等待转录', transcribing: 'Whisper 转录中', checking: '检查转录质量',
  transcribed:'转录完成，等待质量检查', checked:'质量检查通过，等待摘要', summarized:'摘要分段完成', merging:'合并摘要', unknown:'请求状态待核对',
  quality_check: '检查转录质量', summarizing: '生成文本摘要', fallback: 'Gemini 回退',
  gemini_fallback: 'Gemini 回退', waiting_config: '等待 Gemini 配置', ready: '摘要完成', failed: '处理失败',
};
export function AudioPipelineStatus({ audio, disabled, onResume, onRefresh }: {
  audio?: AudioPipelineInfo | null;
  disabled?: boolean;
  onResume: () => void;
  onRefresh: () => void;
}) {
  if (!audio) return null;
  return <div className="callout" aria-label="音频转录质量与回退">
    <strong>{phases[audio.phase] ?? audio.phase}</strong>
    {audio.qualityScore !== null && <p>转录质量评分：{audio.qualityScore.toFixed(2)} · 通过门槛 0.85</p>}
    {audio.transcriptAvailable && <p>机器转录已私有保存，可继续处理。</p>}
    {audio.reasons.length > 0 && <ul>{audio.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <p className="muted">质量评分是 AI 检查结果，不是原音准确率保证。</p>
    {audio.phase === 'waiting_config' && <div className="form-actions">
      <button type="button" className="button button-primary button-small" disabled={disabled || !audio.canResumeFallback} onClick={onResume}>继续 Gemini 回退</button>
      <button type="button" className="button button-quiet button-small" disabled={disabled} onClick={onRefresh}>刷新配置与状态</button>
    </div>}
  </div>;
}
