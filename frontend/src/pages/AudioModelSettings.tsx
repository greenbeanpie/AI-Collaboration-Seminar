import { Field, SectionCard } from '../components/ui';

import type { AudioSettingsView } from './audio-settings-view';

export function AudioModelSettings({ config, disabled, onChange }: { config: AudioSettingsView; disabled: boolean; onChange: (patch: Partial<AudioSettingsView>) => void }) {
  const realtime = config.realtimeAudioTranscription;
  const complete = Boolean(realtime?.gatewayId && (realtime.apiKey || (realtime.keyConfigured && !realtime.clearKey)) && (realtime.gatewayToken || (realtime.gatewayTokenConfigured && !realtime.clearGatewayToken)));
  const editRealtime = (patch: Partial<NonNullable<AudioSettingsView['realtimeAudioTranscription']>>) => onChange({ realtimeAudioTranscription: { ...realtime!, ...patch } });
  return <>
    <SectionCard title="音频文件初步转录模型" detail="文件初步转录独立于音视频理解模型与实时语音模型。">
      <Field label="文件转录供应商"><input className="input" readOnly value="Cloudflare Workers AI" /></Field>
      <Field label="文件转录模型"><input className="input" readOnly value={config.audioFileTranscription.model} /></Field>
      <p className="muted">固定使用 Whisper，需要 Workers AI binding；此处无需 Google 密钥。</p>
    </SectionCard>
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
    <SectionCard title="答辩语音朗读模型" detail="只朗读文字模型已生成的发言，共用上方实时语音 Gateway 凭据；不向朗读模型发送项目资料或答辩历史。">
      <fieldset disabled={disabled}><legend>文字转语音</legend>
        <Field label="答辩朗读模型"><select className="input" value={config.rehearsalSpeech.model} onChange={event => onChange({ rehearsalSpeech: { ...config.rehearsalSpeech, model: event.target.value as AudioSettingsView['rehearsalSpeech']['model'] } })}><option value="gemini-3.8-flash-lite-tts">Gemini 3.8 Flash Lite TTS（默认）</option><option value="gemini-3.8-flash-tts">Gemini 3.8 Flash TTS</option></select></Field>
        <Field label="答辩朗读声音"><select className="input" value={config.rehearsalSpeech.voice} onChange={event => onChange({ rehearsalSpeech: { ...config.rehearsalSpeech, voice: event.target.value as AudioSettingsView['rehearsalSpeech']['voice'] } })}>{['Kore', 'Aoede', 'Puck'].map(voice => <option key={voice}>{voice}</option>)}</select></Field>
      </fieldset>
    </SectionCard>
    <SectionCard title="音频与答辩处理策略" detail="策略与模型分别配置，使用当前页面统一保存；仅修改音频设置不会停用现有文字 AI，保存不发起模型请求。">
      <fieldset disabled={disabled}><legend>处理方式</legend>
        <Field label="音频文件处理策略" hint="Whisper 转录后由现有图文模型检查；全部检查评分至少 0.85 且无关键异常时沿用文本总结，否则回退音视频理解模型。"><select className="input" value={config.processingStrategies.audioFiles} onChange={event => onChange({ processingStrategies: { ...config.processingStrategies, audioFiles: event.target.value as AudioSettingsView['processingStrategies']['audioFiles'] } })}><option value="whisper-first">优先 Whisper 转录（低成本）</option><option value="media-only">直接音视频理解模型</option></select></Field>
        <Field label="模拟答辩处理策略"><select className="input" value={config.processingStrategies.rehearsal} onChange={event => onChange({ processingStrategies: { ...config.processingStrategies, rehearsal: event.target.value as AudioSettingsView['processingStrategies']['rehearsal'] } })}><option value="text">文字答辩（默认）</option><option value="voice-with-text-fallback">轮流语音答辩，失败回退文字</option></select></Field>
        {config.processingStrategies.rehearsal === 'voice-with-text-fallback' && !complete && <p role="note">实时语音配置尚不完整，答辩将回退文字。补齐 Gateway ID、Google 密钥和 Gateway token 后才可使用语音。</p>}
        <p className="muted">仅支持现有两方轮流发言；语音模型负责转录与朗读，判断与问答使用现有文字模型。视频始终使用音视频理解模型。</p>
      </fieldset>
    </SectionCard>
  </>;
}
