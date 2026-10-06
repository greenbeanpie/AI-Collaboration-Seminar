import { AudioModelSettings } from './AudioModelSettings';
import { blankAudioSettings, localSpeechSettings, type AudioSettingsView } from './audio-settings-view';
import { useSettingsDirty } from './settings-dirty';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminRequest, useSession } from '../auth';
import { ErrorNotice, Field, SectionCard } from '../components/ui';
import { API_PROTOCOLS, GO_DEFAULT_USER_AGENT, GO_USAGE_NOTICE, PROVIDER_PRESETS, modelCapabilities, presetEndpoint, protocolForConfig, providerOptionErrors, providerPresets, requiresExplicitApiProtocol, type ApiProtocol, type ProviderOptions, type ProviderPreset } from '../../../shared/ai-providers';

const purposes = ['textEconomy', 'visionEconomy', 'review'] as const;
type Purpose = typeof purposes[number];
type ModelSlot = Purpose | 'unified';
const modelSlots: ModelSlot[] = [...purposes, 'unified'];
const labels = { unified: '统一模型', textEconomy: '文本与要求提取', visionEconomy: '图片与 OCR', review: '预审与答辩' };
type Model = ProviderOptions & { model: string; apiUrl?: string; apiKey?: string; keyConfigured?: boolean; clearKey?: boolean; timeoutMs: number; maxInputChars: number; supportsJson: boolean; supportsVision: boolean };
type Config = Record<ModelSlot, Model> & AudioSettingsView & { routingMode: 'advanced' | 'unified'; searchEnabled?: boolean; audioProcessingStrategy?: 'whisper-first' | 'gemini-only'; mediaUnderstanding?:Model; mimoMediaUnderstanding?:Model };
type Report = { passed: boolean; configVersion: number; checks: { name: string; passed: boolean; detail: string }[] };
const blank = (): Config => ({ ...blankAudioSettings(), routingMode: 'unified', audioProcessingStrategy: 'whisper-first', ...Object.fromEntries(modelSlots.map(p => [p, { provider: 'openai-compatible', model: '', apiUrl: '', timeoutMs: 90000, maxInputChars: 48000, supportsJson: true, supportsVision: p === 'visionEconomy' }])) }) as Config;
function withoutApiUrl(model: Model): Model {
  const { apiUrl, ...rest } = model;
  void apiUrl;
  return rest;
}
function withoutLegacyModelSettings(model: Model): Model {
  const { enabledOutputLimit: _enabledOutputLimit, maxOutputTokens: _maxOutputTokens, pricePerMTokens: _price, cachedInputPricePerMTokens: _cachedPrice, mediaInputPricePerMTokens: _mediaPrices, ...rest } = model as Model & { enabledOutputLimit?: boolean; maxOutputTokens?: number; pricePerMTokens?: [number, number] | null; cachedInputPricePerMTokens?: number; mediaInputPricePerMTokens?: { audio?: number; video?: number; text?: number } };
  void _enabledOutputLimit; void _maxOutputTokens; void _price; void _cachedPrice; void _mediaPrices;
  return rest;
}
function withoutGatewayKey(model: Model): Model { const { apiKey:_apiKey, keyConfigured:_keyConfigured, clearKey:_clearKey, ...rest }=model; void _apiKey; void _keyConfigured; void _clearKey; return rest; }
export function AiSettings() {
  const qc = useQueryClient();
  const session = useSession();
  const [token, setToken] = useState('');
  const tokenRef = useRef(token); tokenRef.current = token;
  const access = session.data?.role === 'super_admin' || Boolean(token.trim());
  const [config, setConfig] = useState<Config>(blank);
  const [reports, setReports] = useState<Partial<Record<Purpose, Report>>>({});
  const [version, setVersion] = useState(0);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(true);
  const [edited, setEdited] = useState(false);
  useSettingsDirty(edited);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const loadSequence = useRef(0);
  const draftRevision = useRef(0);
  const hasSavedUnified = useRef(true);
  const unifiedEdited = useRef(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const previousAdminUser = useRef<string | undefined>(undefined);
  const adminUserId = session.data?.role === 'super_admin' ? session.data.id : undefined;
  useEffect(() => {
    if (!adminUserId) {
      if (previousAdminUser.current && !tokenRef.current.trim()) { loadSequence.current++; draftRevision.current++; setConfig(blank()); setReady(false); setDirty(false); setEdited(false); setReports({}); setVersion(0); setSavedEnabled(false); setMessage('超级管理员权限已移除，请使用有权限的账户或运维令牌。'); }
      previousAdminUser.current = undefined;
      return;
    }
    previousAdminUser.current = adminUserId;
    let cancelled = false;
    const sequence = ++loadSequence.current;
    const revision = draftRevision.current;
    setReady(false); setBusy(true); setError(undefined);
    void adminRequest<{ config: Config; version: number; enabled: boolean }>('/api/v1/admin/ai-config', { method: 'GET' }).then(data => {
      if (cancelled || sequence !== loadSequence.current) return;
      applyLoaded(data, revision);
    }).catch(value => { if (!cancelled && sequence === loadSequence.current) setError(value); })
      .finally(() => { if (!cancelled && sequence === loadSequence.current) setBusy(false); });
    return () => { cancelled = true; };
    // Session identity is the load boundary; form edits must not trigger reloads.
  }, [adminUserId]);
  function applyLoaded(data: { config: Config; version: number; enabled: boolean }, revision: number) {
    const preserveDraft = draftRevision.current !== revision;
    if (!preserveDraft) {
      setConfig(data.version ? { ...blankAudioSettings(), processingStrategies: data.config.processingStrategies ?? { audioFiles: data.config.audioProcessingStrategy === 'gemini-only' ? 'media-only' : 'whisper-first', rehearsal: 'text' }, rehearsalSpeech: localSpeechSettings(data.config.rehearsalSpeech), realtimeAudioTranscription: data.config.realtimeAudioTranscription ? { ...data.config.realtimeAudioTranscription, apiKey: '', gatewayToken: '' } : undefined, audioProcessingStrategy: data.config.audioProcessingStrategy ?? 'whisper-first', mediaUnderstanding:data.config.mediaUnderstanding?{...withoutLegacyModelSettings(data.config.mediaUnderstanding),apiKey:''}:undefined, mimoMediaUnderstanding:data.config.mimoMediaUnderstanding?{...withoutLegacyModelSettings(data.config.mimoMediaUnderstanding),apiKey:''}:undefined, searchEnabled: data.config.searchEnabled === true, routingMode: data.config.routingMode ?? 'advanced', ...Object.fromEntries(modelSlots.map(p => { const model = withoutLegacyModelSettings(data.config[p] ?? blank()[p]); delete model.apiKey; delete model.keyConfigured; delete model.clearKey; return [p, model]; })) } as Config : blank());
      setDirty(false); setEdited(false);
      hasSavedUnified.current = Boolean(data.config.unified);
      unifiedEdited.current = false;
    }
    setVersion(data.version); setSavedEnabled(data.enabled); setReady(true); setReports({});
    setMessage(preserveDraft ? '已读取配置版本，编辑中的表单已保留，尚未保存。' : data.enabled ? '当前 AI 已启用。' : '当前 AI 未启用。');
  }
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return adminRequest<T>(`/api/v1/admin/ai-config${path}`, { method: method as 'GET' | 'POST' | 'PUT', body, token });
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(undefined); setMessage('');
    try { await action(); } catch (e) { setError(e); } finally { running.current = false; setBusy(false); }
  }
  function edit(p: ModelSlot, patch: Partial<Model>) {
    draftRevision.current++;
    if (p === 'unified') unifiedEdited.current = true;
    setConfig(c => ({ ...c, [p]: { ...c[p], ...patch } })); setDirty(true); setEdited(true); setReports({});
  }
  function editMimo(patch: Partial<Model>) {
    draftRevision.current++;
    setConfig(current => ({ ...current, mimoMediaUnderstanding: { ...current.mimoMediaUnderstanding!, ...patch } }));
    setDirty(true); setEdited(true); setReports({});
  }
  function choosePreset(p: ModelSlot, value: string) {
    const preset = value === 'workers-ai' ? 'custom' : value as ProviderPreset;
    const spec = providerPresets[preset];
    const model = spec.models[0] ?? config[p].model;
    const apiUrl = p === 'unified' && preset !== 'custom' ? presetEndpoint(preset, model) : config[p].apiUrl;
    const changedDestination = apiUrl !== config[p].apiUrl;
    const changedSupplier = preset !== (config[p].providerPreset ?? 'custom') || (value === 'workers-ai') !== (config[p].provider === 'workers-ai');
    edit(p, { provider: value === 'workers-ai' ? 'workers-ai' : 'openai-compatible', providerPreset: preset, model, apiUrl, apiProtocol: undefined, gatewayProviderSlug: preset === 'custom' ? config[p].gatewayProviderSlug : undefined, reasoningEffort: undefined, temperature: undefined, topP: undefined, goUsageAcknowledged: false, goHeaders: undefined, supportsJson: spec.supportsJson });
    if (changedSupplier || changedDestination) setMessage(changedDestination ? '统一模型供应商已切换 API 地址；供应商密钥统一由 Cloudflare AI Gateway 提供。' : '供应商已切换；请求将由 Cloudflare AI Gateway 的默认 Provider Key 鉴权。');
  }
  function chooseModel(p: ModelSlot, model: string) {
    const next = { ...config[p], model };
    const caps = modelCapabilities(next);
    edit(p, { model, reasoningEffort: next.reasoningEffort && caps.reasoning.includes(next.reasoningEffort) ? next.reasoningEffort : undefined, temperature: caps.temperature ? next.temperature : undefined, topP: caps.topP ? next.topP : undefined, ...(protocolForConfig(next) === 'messages' ? { supportsJson: false } : {}) });
  }
  function changeEffort(p: ModelSlot, effort: Model['reasoningEffort'] | '') {
    const reasoningEffort = effort || undefined;
    const caps = modelCapabilities({ ...config[p], reasoningEffort });
    edit(p, { reasoningEffort, temperature: caps.temperature ? config[p].temperature : undefined, topP: caps.topP ? config[p].topP : undefined });
  }
  async function save(activate = false) {
    if (!ready) throw new Error('请先成功读取已保存配置，再保存修改。');
    const slots = config.routingMode === 'unified' ? ['unified'] as const : purposes;
    const errors = slots.flatMap(p => providerOptionErrors(config[p]).map(detail => `${labels[p]}：${detail}`));
    if(config.mediaUnderstanding && (!config.mediaUnderstanding.model.trim() || (config.mediaUnderstanding.apiUrl && config.mediaUnderstanding.apiUrl!=='https://generativelanguage.googleapis.com')))errors.push('音视频请填写 Gemini 模型，并使用官方端点');
    if (errors.length) throw new Error(`配置未保存：${errors.join('；')}`);
    // Do not materialize an untouched optional legacy slot just by opening the UI.
    const sanitizedConfig = {
      ...config,
      ...Object.fromEntries(modelSlots.map(p => { const model = withoutLegacyModelSettings(config[p]); delete model.apiKey; delete model.keyConfigured; delete model.clearKey; return [p, model]; })),
      ...(config.mediaUnderstanding ? { mediaUnderstanding: withoutGatewayKey(withoutLegacyModelSettings(config.mediaUnderstanding)) } : {}),
      ...(config.mimoMediaUnderstanding ? { mimoMediaUnderstanding: withoutGatewayKey(withoutLegacyModelSettings(config.mimoMediaUnderstanding)) } : {}),
    } as Config;
    const { unified, mediaUnderstanding, mimoMediaUnderstanding, ...settings } = sanitizedConfig;
    const { textEconomy, visionEconomy, review, ...sharedSettings } = settings;
    const advanced = config.routingMode === 'unified' ? { ...sharedSettings } : { ...sharedSettings, textEconomy, visionEconomy, review };
    const includeUnified = config.routingMode === 'unified' || hasSavedUnified.current || unifiedEdited.current;
    const realtimePayload = config.realtimeAudioTranscription ? { provider: config.realtimeAudioTranscription.provider, model: config.realtimeAudioTranscription.model, gatewayId: config.realtimeAudioTranscription.gatewayId, languageCodes: config.realtimeAudioTranscription.languageCodes?.filter(Boolean), gatewayToken: config.realtimeAudioTranscription.gatewayToken, clearGatewayToken: config.realtimeAudioTranscription.clearGatewayToken } : undefined;
    const data = await call<{ version: number; enabled: boolean }>('PUT', '', { ...advanced, realtimeAudioTranscription: realtimePayload, mediaUnderstanding, mimoMediaUnderstanding, clearMediaUnderstanding:!mediaUnderstanding, clearMimoMediaUnderstanding:!mimoMediaUnderstanding, clearRealtimeAudioTranscription:!config.realtimeAudioTranscription, audioProcessingStrategy:config.processingStrategies.audioFiles === 'mimo-only' ? config.audioProcessingStrategy ?? 'whisper-first' : config.processingStrategies.audioFiles === 'media-only' ? 'gemini-only' : 'whisper-first', ...(includeUnified ? { unified } : {}), ...(activate ? { enabled: true } : {}), expectedVersion: version });
    setVersion(data.version); setSavedEnabled(data.enabled); setDirty(false); setEdited(false); setReports({});
    hasSavedUnified.current = includeUnified; unifiedEdited.current = false;
    setConfig(c => ({ ...c, realtimeAudioTranscription:c.realtimeAudioTranscription?{...c.realtimeAudioTranscription,keyConfigured:false,gatewayTokenConfigured:Boolean(c.realtimeAudioTranscription.gatewayToken)||(!c.realtimeAudioTranscription.clearGatewayToken&&Boolean(c.realtimeAudioTranscription.gatewayTokenConfigured)),apiKey:'',gatewayToken:'',clearKey:false,clearGatewayToken:false}:undefined, mimoMediaUnderstanding:c.mimoMediaUnderstanding?{...withoutLegacyModelSettings(c.mimoMediaUnderstanding),keyConfigured:Boolean(c.mimoMediaUnderstanding.apiKey)||(!c.mimoMediaUnderstanding.clearKey&&Boolean(c.mimoMediaUnderstanding.keyConfigured)),apiKey:'',clearKey:false}:undefined, mediaUnderstanding:c.mediaUnderstanding?{...withoutLegacyModelSettings(c.mediaUnderstanding),keyConfigured:Boolean(c.mediaUnderstanding.apiKey)||(!c.mediaUnderstanding.clearKey&&Boolean(c.mediaUnderstanding.keyConfigured)),apiKey:'',clearKey:false}:undefined, ...Object.fromEntries(modelSlots.map(p => { const model = withoutLegacyModelSettings(c[p]); delete model.apiKey; delete model.keyConfigured; delete model.clearKey; return [p, model]; })) }) as Config);
    setMessage(activate ? 'AI 已启用。' : data.enabled ? '配置已保存，AI 保持启用。' : '配置已保存，AI 未启用。测试结果仅供诊断参考，不影响保存或启用。');
    await qc.invalidateQueries({ queryKey: ['capabilities'] });
  }
  async function disable() {
    if (!ready) throw new Error('请先成功读取已保存配置，再停用 AI。');
    const data = await call<{ version: number; enabled: false }>('POST', '/disable', { expectedVersion: version, enabled: false });
    setVersion(data.version); setSavedEnabled(false); setReports({});
    setMessage(dirty ? 'AI 已停用。未保存的表单修改已保留，请点击保存配置后再测试。' : 'AI 已停用，已保存的模型配置保持不变。');
    await qc.invalidateQueries({ queryKey: ['capabilities'] });
  }
  const requiredProbes = config.routingMode === 'unified' && !config.unified.supportsVision ? purposes.filter(p => p !== 'visionEconomy') : purposes;
  return <SectionCard title="AI 模型接入与测试" detail="系统级设置，使用超级管理员账户登录即可管理。供应商密钥由 Cloudflare AI Gateway 统一托管；设置影响所有项目。">
    <div className="stack">
      {session.data?.role !== 'super_admin' && <p className="muted">需要超级管理员权限；项目负责人可请系统管理员配置，或使用下方运维令牌模式。</p>}
      <details><summary>运维管理员令牌模式（可选）</summary><Field label="管理员令牌" hint="部署时配置的 ADMIN_TOKEN；只在当前页面内存保留。"><input className="input" type="password" autoComplete="off" disabled={busy} value={token} onChange={e => { loadSequence.current++; setToken(e.target.value); setReady(false); setEdited(true); setReports({}); setError(undefined); setMessage('请先读取当前令牌可访问的已保存配置。'); }} /></Field></details>
      <button className="button button-quiet" disabled={!access || busy} onClick={() => void run(async () => {
        const sequence = ++loadSequence.current;
        const revision = draftRevision.current;
        setReady(false);
        const data = await call<{ config: Config; version: number; enabled: boolean }>('GET', '');
        if (sequence === loadSequence.current) applyLoaded(data, revision);
      })}>{edited ? '丢弃修改并读取已保存配置' : ready ? '重新读取已保存配置' : '读取已保存配置'}</button>
      {!ready && <p role="status">{busy ? '正在读取已保存配置，请稍候……' : '尚未成功读取配置版本。请先读取或重试，避免覆盖他人的修改。'}</p>}
      <p className="muted">已保存配置 v{version} · AI {savedEnabled ? '已启用' : '未启用'}{dirty ? ' · 表单修改尚未保存' : ''}</p>
      <label><input type="checkbox" disabled={busy || !ready} checked={config.searchEnabled === true} onChange={e => { draftRevision.current++; setConfig(c => ({ ...c, searchEnabled: e.target.checked })); setDirty(true); setEdited(true); setReports({}); }} /> 允许 AI 使用提供商原生互联网搜索</label><p className="muted">仅支持已核实的供应商能力；工作页面填写公开查询，项目正文和凭据不会作为查询发送。</p><Field label="模型路由模式"><select className="input" disabled={busy || !ready} value={config.routingMode} onChange={e => { draftRevision.current++; setConfig(c => ({ ...c, routingMode: e.target.value as Config['routingMode'] })); setDirty(true); setEdited(true); setReports({}); }}><option value="unified">统一模型（推荐）</option><option value="advanced">高级：按用途配置</option></select></Field>
      <p className="muted">统一模式让提取、评价、拆解、分配和对话使用同一模型配置；高级配置草稿会保留。切换模式后需保存并重新测试。模型不支持图片时，图片任务会明确失败，不会自动改用其他端点。</p>
      <p className="muted">所有模型请求的输出上限由系统固定为 65535 token，不提供手动设置。供应商或模型自身若有更低输出上限，仍以其限制为准。</p>
      {config.routingMode === 'unified' && !config.unified.supportsVision && <p role="note">当前统一模型未声明图片支持：图片 / OCR 不可用；保存后可启用文本功能，图像任务仍不可用。</p>}
      {(config.routingMode === 'unified' ? ['unified'] as const : purposes).map(p => { const caps = modelCapabilities(config[p]); const preset = config[p].providerPreset ?? 'custom'; const protocol = protocolForConfig(config[p]); const requiresExplicitProtocol = requiresExplicitApiProtocol(config[p]); return <fieldset key={p} className="ai-model-settings" disabled={busy || !ready || !access}><legend>{labels[p]}</legend>
        <Field label={`${labels[p]}供应商`} hint={p === 'unified' ? '切换统一模型供应商会应用其建议 API URL 和模型；不会启用 AI 或发出请求。' : '切换供应商只改变供应商和模型预设，API URL 保持不变；不会启用 AI 或发出请求。'}><select className="input" value={config[p].provider === 'workers-ai' ? 'workers-ai' : preset} onChange={e => choosePreset(p, e.target.value)}>{PROVIDER_PRESETS.map(id => <option key={id} value={id}>{providerPresets[id].label}</option>)}<option value="workers-ai">Cloudflare Workers AI（运维配置）</option></select></Field>

        {preset === 'opencode-go' && <div role="note"><p>{GO_USAGE_NOTICE} <a href="https://opencode.ai/docs/go/#where-can-i-use-it" target="_blank" rel="noreferrer">官方使用说明</a></p><label><input type="checkbox" checked={config[p].goUsageAcknowledged ?? false} onChange={e => edit(p, { goUsageAcknowledged: e.target.checked })} /> 我已确认套餐适用于本应用用途</label><p className="muted">使用本应用真实 User-Agent 和稳定会话 ID；不模拟官方客户端，不绕过服务限制。</p><fieldset><legend>OpenCode Go 专用请求头</legend><Field label={`${labels[p]} Go User-Agent`} hint="仅填写你实际应用的名称/版本；不能填写官方客户端身份或密钥。"><input className="input" value={config[p].goHeaders?.userAgent ?? GO_DEFAULT_USER_AGENT} onChange={e => edit(p, { goHeaders: { ...config[p].goHeaders, userAgent: e.target.value } })} /></Field><Field label={`${labels[p]} Go 会话前缀`} hint="x-opencode-session 默认自动按会话/任务生成，重试保持一致。可选非敏感前缀；不填 key、姓名或用户资料。"><input className="input" maxLength={32} value={config[p].goHeaders?.sessionPrefix ?? ''} onChange={e => edit(p, { goHeaders: { ...config[p].goHeaders, sessionPrefix: e.target.value } })} /></Field><p className="muted">鉴权头由后端密钥生成，不允许编辑 Authorization、x-api-key、Cookie、Host 或任意请求头。</p></fieldset></div>}
        <Field label={`${labels[p]} API 协议`} hint={requiresExplicitProtocol ? '此 OpenCode 模型尚未核实，请显式选择其支持的协议；思考参数保持默认。' : '切换协议不会更改 API URL；请确认当前地址支持所选协议。'}><select className="input" value={requiresExplicitProtocol ? '' : protocol} disabled={config[p].provider === 'workers-ai'} onChange={e => { const apiProtocol = e.target.value as ApiProtocol; edit(p, { apiProtocol, supportsJson: apiProtocol === 'messages' ? false : config[p].supportsJson }); }}><option value="" disabled>请选择协议</option>{API_PROTOCOLS.map(style => <option key={style} value={style}>{style}</option>)}</select></Field>
        {preset === 'custom' && <Field label={`${labels[p]} Cloudflare Gateway 自定义 Provider slug`} hint="先在 Cloudflare AI Gateway 创建 Custom Provider，并为其添加默认 Provider Key。请求只带 Gateway 认证，不会带供应商密钥。"><input className="input" maxLength={64} value={config[p].gatewayProviderSlug ?? ''} onChange={e => edit(p, { gatewayProviderSlug: e.target.value.trim().toLowerCase() })} /></Field>}
        {preset === 'opencode-go' || preset === 'opencode-zen' ? <p className="muted">此供应商通过 Cloudflare AI Gateway Custom Provider（custom-{preset}）转发；需先在 Gateway 建立对应 Provider 并配置默认存储密钥。</p> : <p className="muted">供应商 Provider Key 从 Cloudflare AI Gateway 的默认密钥读取。此表单不接收或发送供应商 API Key。</p>}
        <Field label={`${labels[p]}模型名称`}><input className="input" value={config[p].model} list={`models-${p}`} onChange={e => chooseModel(p, e.target.value.trim())} /></Field>
        <datalist id={`models-${p}`}>{providerPresets[preset].models.map(model => <option key={model} value={model} />)}</datalist>
        <Field label={`${labels[p]}思考强度`} hint={caps.reasoning.length ? '默认不发送该参数，沿用供应商默认值；各模型可选范围不同。' : '此模型未核实思考参数支持，保持默认，不发送参数。'}><select className="input" value={config[p].reasoningEffort ?? ''} onChange={e => changeEffort(p, e.target.value as Model['reasoningEffort'] | '')}><option value="">默认（不发送）</option>{caps.reasoning.map(effort => <option key={effort} value={effort}>{effort}</option>)}{config[p].reasoningEffort && !caps.reasoning.includes(config[p].reasoningEffort!) && <option value={config[p].reasoningEffort}>不支持：{config[p].reasoningEffort}</option>}</select></Field>
        <details><summary>常用参数与调用上限</summary>
          <Field label={`${labels[p]} temperature`} hint={caps.temperature ? '0–2；留空不发送。通常与 top_p 二选一。' : preset === 'gemini' ? '按官方建议使用默认采样，请留空。' : '此模型/思考模式不支持；请留空。'}><input className="input" type="number" min="0" max="2" step="0.1" value={config[p].temperature ?? ''} onChange={e => edit(p, { temperature: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]} top_p`} hint={caps.topP ? `${caps.minTopP}–1；留空不发送。` : preset === 'gemini' ? '按官方建议使用默认采样，请留空。' : '此模型/思考模式未核实支持；请留空。'}><input className="input" type="number" min={caps.minTopP} max="1" step="0.01" value={config[p].topP ?? ''} onChange={e => edit(p, { topP: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}超时（毫秒）`}><input className="input" type="number" min="1000" max="600000" step="1000" value={config[p].timeoutMs} onChange={e => edit(p, { timeoutMs: Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}最大输入字符`}><input className="input" type="number" min="1" value={config[p].maxInputChars} onChange={e => edit(p, { maxInputChars: Number(e.target.value) })} /></Field>
          <label><input type="checkbox" checked={config[p].supportsVision} onChange={e => edit(p, { supportsVision: e.target.checked })} /> 声明模型支持图片输入（仍需探测）</label>
          <p className="muted">保留调用内恢复与 JSON 修复；仍有效的失败作业由后台每隔至少一分钟恢复，连续三次恢复失败后停止，不自动换模型。权限或输入限制失效时停止；每项目同时运行的 AI 任务最多两个。</p>
        </details>
        <label><input type="checkbox" disabled={protocol === 'messages'} checked={config[p].supportsJson} onChange={e => edit(p, { supportsJson: e.target.checked })} /> 服务支持协议对应的 JSON 输出约束（不支持时取消，仍会校验 JSON 输出）</label>
        {providerOptionErrors(config[p]).map(detail => <p className="muted" key={detail}>{detail}</p>)}
      </fieldset>; })}
      <SectionCard title="音视频理解模型" detail="现有 Gemini 音视频理解与摘要配置，与文件转录和实时语音转录独立。"><fieldset disabled={!access || busy || !ready}><legend>音视频摘要模型（可选）</legend>
        <p className="muted">与图文模型分开配置，统一模型模式不会覆盖。支持 MP3、WAV、M4A、MP4、WebM，单文件 50 MiB。只生成 AI 摘要；视频同时理解画面与声音。长音频会分窗口处理。</p>
        <p className="muted">媒体文件上传、模型检查与摘要均通过 Cloudflare AI Gateway 的 Google AI Studio Provider。Google 默认 Provider Key 必须预先存储在 Gateway；应用不接收供应商密钥。</p>
        <label><input type="checkbox" checked={Boolean(config.mediaUnderstanding)} onChange={e=>{draftRevision.current++;setConfig(c=>({...c,mediaUnderstanding:e.target.checked?{...withoutApiUrl(blank().textEconomy),provider:'openai-compatible',providerPreset:'gemini',model:'gemini-2.5-flash',supportsVision:true}:undefined}));setDirty(true);setEdited(true);}} /> 配置音视频摘要模型</label>
        {config.mediaUnderstanding && <>
          <button className="button button-quiet" type="button" disabled={busy||dirty||!version} onClick={()=>void run(async()=>{const result=await call<{passed:boolean;detail:string}>('POST','/media-probe');setMessage(result.detail);if(!result.passed)throw new Error(result.detail);})}>测试音视频模型元数据（不生成）</button>
          <Field label="音视频 Gemini 模型"><input className="input" value={config.mediaUnderstanding.model} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,model:e.target.value}}));draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>
          <Field label="音视频官方端点"><input className="input" readOnly value="https://generativelanguage.googleapis.com" /></Field>
          <Field label="音视频超时（毫秒）"><input className="input" type="number" min="1000" max="600000" value={config.mediaUnderstanding.timeoutMs} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,timeoutMs:Number(e.target.value)}}));draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>
        </>}
      </fieldset></SectionCard>
      <SectionCard title="MiMo 音视频理解模型" detail="小米官方独立配置；保存草稿不会切换策略，也不影响 Gemini。"><fieldset disabled={!access || busy || !ready}><legend>MiMo 摘要模型（可选）</legend>
        <p className="muted">上传资料和草稿经 Cloudflare AI Gateway 自定义 Provider「xiaomi-mimo」生成 AI 摘要。请先在 Gateway 创建 Custom Provider 并添加默认 Provider Key。支持 MP3、WAV、M4A、MP4，单文件 50 MiB；WebM 请使用现有路径。视频默认每秒 2 帧。</p>
        <label><input type="checkbox" checked={Boolean(config.mimoMediaUnderstanding)} onChange={event => { draftRevision.current++; setConfig(current => ({ ...current, mimoMediaUnderstanding: event.target.checked ? { ...withoutApiUrl(blank().textEconomy), provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro', supportsVision: true } : undefined })); setDirty(true); setEdited(true); setReports({}); }} /> 配置 MiMo 音视频摘要模型</label>
        {config.mimoMediaUnderstanding && <>
          <button className="button button-quiet" type="button" disabled={busy || dirty || !version} onClick={() => void run(async () => { const result = await call<{ passed: boolean; detail: string }>('POST', '/mimo-media-probe'); setMessage(result.detail); if (!result.passed) throw new Error(result.detail); })}>测试 MiMo 模型元数据（不生成）</button>
          <p className="muted">元数据测试仅检查访问权限，不代表音频识别质量或视频理解已验证。真实音频识别需上传样本验证。</p>
          <Field label="MiMo 模型"><input className="input" readOnly value="mimo-v2.6-pro" /></Field>
          <Field label="MiMo 官方端点"><input className="input" readOnly value="https://api.xiaomimimo.com/v1" /></Field>
          <Field label="MiMo 超时（毫秒）"><input className="input" type="number" min="1000" max="600000" value={config.mimoMediaUnderstanding.timeoutMs} onChange={event => editMimo({ timeoutMs: Number(event.target.value) })} /></Field>
        </>}
      </fieldset></SectionCard>
      <AudioModelSettings config={config} disabled={!access || busy || !ready} onChange={patch => { draftRevision.current++; setConfig(current => ({ ...current, ...patch })); setDirty(true); setEdited(true); setReports({}); }} />
      <div className="form-actions">{requiredProbes.map(p => <div key={p}>
        <button className="button button-quiet" disabled={!access || busy || !ready || dirty || !version} onClick={() => void run(async () => {
          const report = await call<Report>('POST', '/probe', { purpose: p });
          setReports(r => ({ ...r, [p]: report }));
        })}>测试{labels[p]}（连接与能力）</button>
        {reports[p] && <div role="status"><strong>{reports[p]?.passed ? '测试通过' : '测试失败'} · 配置 v{reports[p]?.configVersion}</strong><ul>{reports[p]?.checks.map(c => <li key={c.name}>{c.passed ? '✓' : '✗'} {c.name}：{c.detail}</li>)}</ul></div>}
      </div>)}</div>
      <p className="muted">所有供应商请求通过 Cloudflare AI Gateway。请在 Gateway 的 Provider Keys 中为所用供应商配置默认存储密钥；保存配置、停用 AI 和启用 AI 不发请求。测试按钮会发起少量真实模型请求，可能产生费用；测试结果仅作诊断。</p>
      <div className="form-actions"><button className="button button-primary" disabled={!access || busy || !ready} onClick={() => void run(() => save())}>保存配置</button><button className="button button-quiet" disabled={!access || busy || !ready || !version} onClick={() => void run(disable)}>停用 AI</button><button className="button button-primary" disabled={!access || busy || !ready || !version || dirty || savedEnabled} onClick={() => void run(() => save(true))}>{savedEnabled ? 'AI 已启用' : '启用 AI'}</button></div>
      {busy && <p role="status">正在处理，请稍候……</p>}{message && <p role="status">{message}</p>}{Boolean(error) && <ErrorNotice error={error} />}
    </div>
  </SectionCard>;
}
