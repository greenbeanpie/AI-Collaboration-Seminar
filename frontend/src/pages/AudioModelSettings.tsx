import { Field, SectionCard } from '../components/ui';

import type { AudioSettingsView } from './audio-settings-view';

export function AudioModelSettings({ config, disabled, onChange }: { config: AudioSettingsView; disabled: boolean; onChange: (patch: Partial<AudioSettingsView>) => void }) {
  const realtime = config.realtimeAudioTranscription;
  const complete = Boolean(realtime?.gatewayId && (realtime.apiKey || (realtime.keyConfigured && !realtime.clearKey)) && (realtime.gatewayToken || (realtime.gatewayTokenConfigured && !realtime.clearGatewayToken)));
  const editRealtime = (patch: Partial<NonNullable<AudioSettingsView['realtimeAudioTranscription']>>) => onChange({ realtimeAudioTranscription: { ...realtime!, ...patch } });
  return <>
    <Field label="文件转录模型"><input className="input" readOnly value={config.audioFileTranscription.model} /></Field>
    <SectionCard title="实时语音转录模型" detail="Gemini 3.5 Transcribe Live 仅负责将发言转为文字；答辩内容分析和问题生成继续使用现有文字模型。">
      <fieldset disabled={disabled}><legend>Cloudflare AI Gateway 转发配置</legend>
        <label><input type="checkbox" checked={Boolean(realtime)} onChange={event => onChange({ realtimeAudioTranscription: event.target.checked ? { provider: 'google-ai-studio', model: 'gemini-3.5-transcribe-live', gatewayId: '', apiKey: '', gatewayToken: '' } : undefined })} /> 配置实时语音转录</label>
        {realtime && <>
          <Field label="实时转录模型"><input className="input" readOnly value="gemini-3.5-transcribe-live" /></Field>
          <Field label="实时语音 Gateway ID" hint="Cloudflare AI Gateway 标识；仅小写字母、数字和连字符。未完成的配置可作为草稿保存。"><input className="input" maxLength={64} value={realtime.gatewayId} onChange={event => editRealtime({ gatewayId: event.target.value.trim() })} /></Field>
          <Field label="实时语音 Google API key" hint={realtime.keyConfigured ? '已保存；留空保留，不回显。' : '尚未配置。'}><input className="input" type="password" autoComplete="off" value={realtime.apiKey ?? ''} onChange={event => editRealtime({ apiKey: event.target.value })} /></Field>
          {realtime.keyConfigured && <label><input type="checkbox" checked={realtime.clearKey ?? false} onChange={event => editRealtime({ clearKey: event.target.checked })} /> 清除实时语音 Google 密钥</label>}
          <Field label="实时语音 Gateway token" hint={realtime.gatewayTokenConfigured ? '已保存；留空保留，不回显。' : '尚未配置。'}><input className="input" type="password" autoComplete="off" value={realtime.gatewayToken ?? ''} onChange={event => editRealtime({ gatewayToken: event.target.value })} /></Field>
          {realtime.gatewayTokenConfigured && <label><input type="checkbox" checked={realtime.clearGatewayToken ?? false} onChange={event => editRealtime({ clearGatewayToken: event.target.checked })} /> 清除实时语音 Gateway token</label>}
          <Field label="实时转录语言提示" hint="可选 BCP-47 语言代码，最多 8 个，使用逗号分隔，例如 zh-CN,en-US；留空自动识别。"><input className="input" value={realtime.languageCodes?.join(',') ?? ''} onChange={event => editRealtime({ languageCodes: event.target.value.split(',').map(value => value.trim()) })} /></Field>
        </>}
        <p className="muted">新语音请求只通过 Cloudflare AI Gateway 转发，不提供 Google 直连 URL；不会复制音视频理解模型的密钥。</p>
      </fieldset>
    </SectionCard>
    <SectionCard title="答辩语音朗读" detail="使用设备的系统本地语音朗读，无服务器调用，无需 Gateway 或 Google 密钥。">
      <fieldset disabled={disabled}><legend>系统本地文字转语音</legend>
        <Field label="朗读语言" hint="单个 BCP-47 语言代码，例如 zh-CN 或 en-US。"><input className="input" value={config.rehearsalSpeech.lang} onChange={event => onChange({ rehearsalSpeech: { ...config.rehearsalSpeech, lang: event.target.value.trim() } })} /></Field>
        <Field label="朗读语速" hint="0.5–2；1 为默认语速。"><input className="input" type="number" min="0.5" max="2" step="0.1" value={config.rehearsalSpeech.rate} onChange={event => onChange({ rehearsalSpeech: { ...config.rehearsalSpeech, rate: Number(event.target.value) } })} /></Field>
        <Field label="朗读音量" hint="0–1；1 为最大音量。"><input className="input" type="number" min="0" max="1" step="0.1" value={config.rehearsalSpeech.volume} onChange={event => onChange({ rehearsalSpeech: { ...config.rehearsalSpeech, volume: Number(event.target.value) } })} /></Field>
        <p className="muted">自动选用设备提供的本地语音。文字答辩也可朗读；设备没有可用本地语音时保留文字。</p>
      </fieldset>
    </SectionCard>
    <SectionCard title="音频与答辩处理策略" detail="策略与模型分别配置，使用当前页面统一保存；仅修改音频设置不会停用现有文字 AI，保存不发起模型请求。">
      <fieldset disabled={disabled}><legend>处理方式</legend>
        <Field label="音频文件处理策略" hint="Whisper 转录后由现有图文模型检查；全部检查评分至少 0.85 且无关键异常时沿用文本总结，否则回退音视频理解模型。"><select className="input" value={config.processingStrategies.audioFiles} onChange={event => onChange({ processingStrategies: { ...config.processingStrategies, audioFiles: event.target.value as AudioSettingsView['processingStrategies']['audioFiles'] } })}><option value="whisper-first">优先 Whisper 转录（低成本）</option><option value="media-only">直接 Gemini 音视频理解</option><option value="mimo-only">直接 MiMo 音视频理解</option></select></Field>
        <Field label="视频文件处理策略" hint="缺省使用 Gemini；MiMo 失败不自动切换供应商。"><select className="input" value={config.processingStrategies.videoFiles ?? 'gemini'} onChange={event => onChange({ processingStrategies: { ...config.processingStrategies, videoFiles: event.target.value as 'gemini' | 'mimo' } })}><option value="gemini">Gemini（现有默认）</option><option value="mimo">MiMo</option></select></Field>
        <Field label="模拟答辩处理策略"><select className="input" value={config.processingStrategies.rehearsal} onChange={event => onChange({ processingStrategies: { ...config.processingStrategies, rehearsal: event.target.value as AudioSettingsView['processingStrategies']['rehearsal'] } })}><option value="text">文字答辩（默认）</option><option value="voice-with-text-fallback">轮流语音答辩，失败回退文字</option></select></Field>
        {config.processingStrategies.rehearsal === 'voice-with-text-fallback' && !complete && <p role="note">实时语音配置尚不完整，答辩将回退文字。补齐 Gateway ID、Google 密钥和 Gateway token 后才可使用语音。</p>}
        <p className="muted">仅支持现有两方轮流发言；实时语音模型负责转录，朗读使用系统本地语音；判断与问答使用现有文字模型。音视频策略分别选择；Whisper 检查失败仍回退现有 Gemini。</p>
      </fieldset>
    </SectionCard>
  </>;
}
