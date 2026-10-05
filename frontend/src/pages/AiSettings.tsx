import { AudioModelSettings } from './AudioModelSettings';
import { blankAudioSettings, type AudioSettingsView } from './audio-settings-view';
import { useSettingsDirty } from './settings-dirty';
import { AiDiagnosticsPanel } from './AiDiagnosticsPanel';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminRequest, useSession } from '../auth';
import { ErrorNotice, Field, SectionCard } from '../components/ui';
import { API_PROTOCOLS, GO_DEFAULT_USER_AGENT, GO_USAGE_NOTICE, PROVIDER_PRESETS, modelCapabilities, presetEndpoint, protocolForConfig, providerOptionErrors, providerPresets, type ApiProtocol, type ProviderOptions, type ProviderPreset } from '../../../shared/ai-providers';

const purposes = ['textEconomy', 'visionEconomy', 'review'] as const;
type Purpose = typeof purposes[number];
type ModelSlot = Purpose | 'unified';
const modelSlots: ModelSlot[] = [...purposes, 'unified'];
const labels = { unified: '统一模型', textEconomy: '文本与要求提取', visionEconomy: '图片与 OCR', review: '预审与答辩' };
type Model = ProviderOptions & { model: string; apiUrl: string; apiKey?: string; keyConfigured?: boolean; clearKey?: boolean; timeoutMs: number; maxInputChars: number; maxOutputTokens: number; supportsJson: boolean; supportsVision: boolean; mediaInputPricePerMTokens?:{audio?:number;video?:number;text?:number}; pricePerMTokens: [number, number] | null };
type Config = Record<ModelSlot, Model> & AudioSettingsView & { routingMode: 'advanced' | 'unified'; searchEnabled?: boolean; audioProcessingStrategy?: 'whisper-first' | 'gemini-only'; mediaUnderstanding?:Model };
type TokenLimits = { routingMode: Config['routingMode']; values: Partial<Record<ModelSlot, number>>; enabled: Partial<Record<ModelSlot, boolean>> };
type Report = { passed: boolean; configVersion: number; checks: { name: string; passed: boolean; detail: string }[] };
const blank = (): Config => ({ ...blankAudioSettings(), routingMode: 'unified', audioProcessingStrategy: 'whisper-first', ...Object.fromEntries(modelSlots.map(p => [p, { provider: 'openai-compatible', model: '', apiUrl: '', apiKey: '', timeoutMs: 90000, maxInputChars: 48000, enabledOutputLimit: true, maxOutputTokens: 4096, supportsJson: true, supportsVision: p === 'visionEconomy', pricePerMTokens: null }])) }) as Config;
const tokenLimits = (config: Partial<Config>): TokenLimits => ({ routingMode: config.routingMode ?? 'advanced', values: Object.fromEntries(modelSlots.flatMap(p => typeof config[p]?.maxOutputTokens === 'number' ? [[p, config[p]!.maxOutputTokens]] : [])), enabled: Object.fromEntries(modelSlots.map(p => [p, config[p]?.enabledOutputLimit !== false])) });

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
  const [savedTokenLimits, setSavedTokenLimits] = useState<TokenLimits>(() => tokenLimits({}));
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
      setConfig(data.version ? { ...blankAudioSettings(), processingStrategies: data.config.processingStrategies ?? { audioFiles: data.config.audioProcessingStrategy === 'gemini-only' ? 'media-only' : 'whisper-first', rehearsal: 'text' }, rehearsalSpeech: data.config.rehearsalSpeech ?? blankAudioSettings().rehearsalSpeech, realtimeAudioTranscription: data.config.realtimeAudioTranscription ? { ...data.config.realtimeAudioTranscription, apiKey: '', gatewayToken: '' } : undefined, audioProcessingStrategy: data.config.audioProcessingStrategy ?? 'whisper-first', mediaUnderstanding:data.config.mediaUnderstanding?{...data.config.mediaUnderstanding,apiKey:''}:undefined, searchEnabled: data.config.searchEnabled === true, routingMode: data.config.routingMode ?? 'advanced', ...Object.fromEntries(modelSlots.map(p => [p, { ...(data.config[p] ?? blank()[p]), enabledOutputLimit: data.config[p]?.enabledOutputLimit ?? true, apiKey: '' }])) } as Config : blank());
      setDirty(false); setEdited(false);
      hasSavedUnified.current = Boolean(data.config.unified);
      unifiedEdited.current = false;
    }
    setVersion(data.version); setSavedEnabled(data.enabled); setSavedTokenLimits(tokenLimits(data.config)); setReady(true); setReports({});
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
  function choosePreset(p: ModelSlot, value: string) {
    const preset = value === 'workers-ai' ? 'custom' : value as ProviderPreset;
    const spec = providerPresets[preset];
    const model = spec.models[0] ?? config[p].model;
    const apiUrl = preset === 'custom' ? config[p].apiUrl : presetEndpoint(preset, model);
    const changedDestination = apiUrl !== config[p].apiUrl || (value === 'workers-ai') !== (config[p].provider === 'workers-ai');
    edit(p, { provider: value === 'workers-ai' ? 'workers-ai' : 'openai-compatible', providerPreset: preset, model, apiUrl, apiProtocol: undefined, reasoningEffort: undefined, temperature: undefined, topP: undefined, goUsageAcknowledged: false, goHeaders: undefined, supportsJson: spec.supportsJson, ...(changedDestination ? { apiKey: '', clearKey: true } : {}) });
    if (changedDestination) setMessage('已切换预设。请为新地址重新输入 key；旧 key 不会转发到新供应商。');
  }
  function chooseModel(p: ModelSlot, model: string) {
    const preset = config[p].providerPreset ?? 'custom';
    const next = { ...config[p], model };
    const caps = modelCapabilities(next);
    edit(p, { model, ...(preset !== 'custom' ? { apiUrl: presetEndpoint(preset, model, config[p].apiProtocol) } : {}), reasoningEffort: next.reasoningEffort && caps.reasoning.includes(next.reasoningEffort) ? next.reasoningEffort : undefined, temperature: caps.temperature ? next.temperature : undefined, topP: caps.topP ? next.topP : undefined, ...(protocolForConfig(next) === 'messages' ? { supportsJson: false } : {}) });
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
    for (const p of slots) if (!Number.isSafeInteger(config[p].maxOutputTokens) || config[p].maxOutputTokens < 1) errors.push(`${labels[p]}输出上限必须为可安全表示的正整数 token`);
    if(config.mediaUnderstanding && (!config.mediaUnderstanding.model.trim() || config.mediaUnderstanding.apiUrl!=='https://generativelanguage.googleapis.com'))errors.push('音视频请填写 Gemini 模型，并使用官方端点');
    if (errors.length) throw new Error(`配置未保存：${errors.join('；')}`);
    // Do not materialize an untouched optional legacy slot just by opening the UI.
    const { unified, ...advanced } = config;
    const includeUnified = config.routingMode === 'unified' || hasSavedUnified.current || unifiedEdited.current;
    const realtimePayload = config.realtimeAudioTranscription ? { provider: config.realtimeAudioTranscription.provider, model: config.realtimeAudioTranscription.model, gatewayId: config.realtimeAudioTranscription.gatewayId, languageCodes: config.realtimeAudioTranscription.languageCodes?.filter(Boolean), apiKey: config.realtimeAudioTranscription.apiKey, clearKey: config.realtimeAudioTranscription.clearKey, gatewayToken: config.realtimeAudioTranscription.gatewayToken, clearGatewayToken: config.realtimeAudioTranscription.clearGatewayToken } : undefined;
    const data = await call<{ version: number; enabled: boolean }>('PUT', '', { ...advanced, realtimeAudioTranscription: realtimePayload, clearMediaUnderstanding:!config.mediaUnderstanding, clearRealtimeAudioTranscription:!config.realtimeAudioTranscription, audioProcessingStrategy:config.processingStrategies.audioFiles === 'media-only' ? 'gemini-only' : 'whisper-first', ...(includeUnified ? { unified } : {}), ...(activate ? { enabled: true } : {}), expectedVersion: version });
    setVersion(data.version); setSavedEnabled(data.enabled); setSavedTokenLimits(tokenLimits(includeUnified ? config : advanced)); setDirty(false); setEdited(false); setReports({});
    hasSavedUnified.current = includeUnified; unifiedEdited.current = false;
    setConfig(c => ({ ...c, realtimeAudioTranscription:c.realtimeAudioTranscription?{...c.realtimeAudioTranscription,keyConfigured:Boolean(c.realtimeAudioTranscription.apiKey)||(!c.realtimeAudioTranscription.clearKey&&Boolean(c.realtimeAudioTranscription.keyConfigured)),gatewayTokenConfigured:Boolean(c.realtimeAudioTranscription.gatewayToken)||(!c.realtimeAudioTranscription.clearGatewayToken&&Boolean(c.realtimeAudioTranscription.gatewayTokenConfigured)),apiKey:'',gatewayToken:'',clearKey:false,clearGatewayToken:false}:undefined, mediaUnderstanding:c.mediaUnderstanding?{...c.mediaUnderstanding,keyConfigured:Boolean(c.mediaUnderstanding.apiKey)||(!c.mediaUnderstanding.clearKey&&Boolean(c.mediaUnderstanding.keyConfigured)),apiKey:'',clearKey:false}:undefined, ...Object.fromEntries(modelSlots.map(p => [p, { ...c[p], keyConfigured: Boolean(c[p].apiKey) || (!c[p].clearKey && Boolean(c[p].keyConfigured)), apiKey: '', clearKey: false }])) }) as Config);
    setMessage(activate ? 'AI 已启用，可继续真实业务测试。' : data.enabled ? '配置已保存，AI 保持启用。' : '配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
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
  return <SectionCard title="AI 模型接入与测试" detail="系统级设置，使用超级管理员账户登录即可管理。API URL、key 和模型名称由你填写；设置影响所有项目。">
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
      <fieldset className="ai-model-settings" disabled={busy || !ready || !access}>
        <legend>全局输出 token 上限</legend>
        <p className="muted">系统级设置，影响所有项目。统一模式共用一个上限；高级模式按用途分别设置。单位是每次请求的输出 token，不是累计用量额度，也不保证正文能输出相同数量；部分模型的思考 token 同样占用输出预算。</p>
        <p data-testid="saved-token-limits">已保存 v{version}：{version ? (savedTokenLimits.routingMode === 'unified' ? ['unified'] as const : purposes).map(p => savedTokenLimits.enabled[p] === false ? `${labels[p]} 已关闭（保留 ${savedTokenLimits.values[p]} token）` : `${labels[p]} ${savedTokenLimits.values[p] ?? '未配置'} token / 次`).join('；') : '尚无已保存上限'} · AI {savedEnabled ? '已启用' : '未启用'}</p>
        {(config.routingMode === 'unified' ? ['unified'] as const : purposes).map(p => <div className="stack" key={p}>
          <label><input type="checkbox" checked={config[p].enabledOutputLimit !== false} onChange={e => edit(p, { enabledOutputLimit: e.target.checked })} /> 启用{labels[p]}输出 token 上限</label>
          <Field label={`${labels[p]}最大输出 token`} hint="每次请求的正整数 token；本系统不设固定业务最大值，保留数字精度校验。"><input className="input" type="number" min="1" step="1" disabled={config[p].enabledOutputLimit === false} value={config[p].maxOutputTokens} onChange={e => edit(p, { maxOutputTokens: Number(e.target.value) })} /></Field>
          {protocolForConfig(config[p]) === 'messages' && <p role="note">Messages 协议必填 max_tokens，必须启用输出上限并自行设置；不能省略该参数。</p>}
        </div>)}
        <p className="muted">关闭后，允许省略上限的协议不会发送输出上限参数，也不会自动回退到 4096 或 32768。供应商的默认值和模型自身上限仍然适用；关闭不代表无限输出。关闭时保留输入值，便于再次启用。</p>
        <p className="muted">修改的是表单草稿，需点击下方“保存配置”。保存并启用后用于后续任务，不改写已冻结的旧配置版本；更改上限沿用现有停用、测试与启用流程。</p>
        <p className="muted">累计费用预算单独在各项目的“项目设置 → AI 预算”中管理，单位为美元（USD）。有限金额预算要求启用输出上限以估算费用；关闭后仍记录实际用量。本系统没有全局累计 token 额度；输入长度按字符限制，并发与重试保护仍独立保留。</p>
      </fieldset>
      {config.routingMode === 'unified' && !config.unified.supportsVision && <p role="note">当前统一模型未声明图片支持：图片 / OCR 不可用；文本功能可在文本与评价测试通过后启用。</p>}
      {(config.routingMode === 'unified' ? ['unified'] as const : purposes).map(p => { const caps = modelCapabilities(config[p]); const preset = config[p].providerPreset ?? 'custom'; const protocol = protocolForConfig(config[p]); return <fieldset key={p} className="ai-model-settings" disabled={busy || !ready || !access}><legend>{labels[p]}</legend>
        <Field label={`${labels[p]}供应商`} hint="选择预设只填入建议地址和模型；不会启用 AI 或发出请求。自定义保留现有兼容接口。"><select className="input" value={config[p].provider === 'workers-ai' ? 'workers-ai' : preset} onChange={e => choosePreset(p, e.target.value)}>{PROVIDER_PRESETS.map(id => <option key={id} value={id}>{providerPresets[id].label}</option>)}<option value="workers-ai">Cloudflare Workers AI（运维配置）</option></select></Field>

        {preset === 'opencode-go' && <div role="note"><p>{GO_USAGE_NOTICE} <a href="https://opencode.ai/docs/go/#where-can-i-use-it" target="_blank" rel="noreferrer">官方使用说明</a></p><label><input type="checkbox" checked={config[p].goUsageAcknowledged ?? false} onChange={e => edit(p, { goUsageAcknowledged: e.target.checked })} /> 我已确认套餐适用于本应用用途</label><p className="muted">使用本应用真实 User-Agent 和稳定会话 ID；不模拟官方客户端，不绕过服务限制。</p><fieldset><legend>OpenCode Go 专用请求头</legend><Field label={`${labels[p]} Go User-Agent`} hint="仅填写你实际应用的名称/版本；不能填写官方客户端身份或密钥。"><input className="input" value={config[p].goHeaders?.userAgent ?? GO_DEFAULT_USER_AGENT} onChange={e => edit(p, { goHeaders: { ...config[p].goHeaders, userAgent: e.target.value } })} /></Field><Field label={`${labels[p]} Go 会话前缀`} hint="x-opencode-session 默认自动按会话/任务生成，重试保持一致。可选非敏感前缀；不填 key、姓名或用户资料。"><input className="input" maxLength={32} value={config[p].goHeaders?.sessionPrefix ?? ''} onChange={e => edit(p, { goHeaders: { ...config[p].goHeaders, sessionPrefix: e.target.value } })} /></Field><p className="muted">鉴权头由后端密钥生成，不允许编辑 Authorization、x-api-key、Cookie、Host 或任意请求头。</p></fieldset></div>}
        <Field label={`${labels[p]} API 协议`} hint="协议可手动选择；预设给出推荐值，已核实不兼容的组合会明确拒绝。"><select className="input" value={protocol} disabled={config[p].provider === 'workers-ai'} onChange={e => { const apiProtocol = e.target.value as ApiProtocol; edit(p, { apiProtocol, ...(preset !== 'custom' ? { apiUrl: presetEndpoint(preset, config[p].model, apiProtocol) } : {}), supportsJson: apiProtocol === 'messages' ? false : config[p].supportsJson }); }}>{API_PROTOCOLS.map(style => <option key={style} value={style}>{style}</option>)}</select></Field>
        <Field label={`${labels[p]} API URL`} hint="完整 HTTPS 请求地址，不能含密钥或查询参数；修改地址需重新输入 key 或清除旧 key。"><input className="input" type="url" autoComplete="off" value={config[p].apiUrl ?? ''} onChange={e => edit(p, { apiUrl: e.target.value.trim(), ...(preset !== 'custom' && e.target.value.trim() !== presetEndpoint(preset, config[p].model, config[p].apiProtocol) ? { providerPreset: 'custom', apiProtocol: protocol, goHeaders: undefined, goUsageAcknowledged: undefined } : {}) })} /></Field>
        <Field label={`${labels[p]} API key`} hint={config[p].keyConfigured ? '已保存密钥，留空保留；不会回显。' : '尚未填写密钥。'}><input className="input" type="password" autoComplete="off" value={config[p].apiKey ?? ''} onChange={e => edit(p, { apiKey: e.target.value })} /></Field>
        {config[p].keyConfigured && <label><input type="checkbox" checked={config[p].clearKey ?? false} onChange={e => edit(p, { clearKey: e.target.checked })} /> 清除已保存的 key</label>}
        <Field label={`${labels[p]}模型名称`}><input className="input" value={config[p].model} list={`models-${p}`} onChange={e => chooseModel(p, e.target.value.trim())} /></Field>
        <datalist id={`models-${p}`}>{providerPresets[preset].models.map(model => <option key={model} value={model} />)}</datalist>
        <Field label={`${labels[p]}思考强度`} hint={caps.reasoning.length ? '默认不发送该参数，沿用供应商默认值；各模型可选范围不同。' : '此模型未核实思考参数支持，保持默认，不发送参数。'}><select className="input" value={config[p].reasoningEffort ?? ''} onChange={e => changeEffort(p, e.target.value as Model['reasoningEffort'] | '')}><option value="">默认（不发送）</option>{caps.reasoning.map(effort => <option key={effort} value={effort}>{effort}</option>)}{config[p].reasoningEffort && !caps.reasoning.includes(config[p].reasoningEffort!) && <option value={config[p].reasoningEffort}>不支持：{config[p].reasoningEffort}</option>}</select></Field>
        <details><summary>常用参数与调用上限</summary>
          <Field label={`${labels[p]} temperature`} hint={caps.temperature ? '0–2；留空不发送。通常与 top_p 二选一。' : preset === 'gemini' ? '按官方建议使用默认采样，请留空。' : '此模型/思考模式不支持；请留空。'}><input className="input" type="number" min="0" max="2" step="0.1" value={config[p].temperature ?? ''} onChange={e => edit(p, { temperature: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]} top_p`} hint={caps.topP ? `${caps.minTopP}–1；留空不发送。` : preset === 'gemini' ? '按官方建议使用默认采样，请留空。' : '此模型/思考模式未核实支持；请留空。'}><input className="input" type="number" min={caps.minTopP} max="1" step="0.01" value={config[p].topP ?? ''} onChange={e => edit(p, { topP: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}超时（毫秒）`}><input className="input" type="number" min="1000" max="600000" step="1000" value={config[p].timeoutMs} onChange={e => edit(p, { timeoutMs: Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}最大输入字符`}><input className="input" type="number" min="1" value={config[p].maxInputChars} onChange={e => edit(p, { maxInputChars: Number(e.target.value) })} /></Field>
          <label><input type="checkbox" checked={config[p].supportsVision} onChange={e => edit(p, { supportsVision: e.target.checked })} /> 声明模型支持图片输入（仍需探测）</label>
          <p className="muted">保留调用内恢复与 JSON 修复；仍有效的失败作业由后台每隔至少一分钟恢复，连续三次恢复失败后停止，不自动换模型。权限、输入或预算失效时停止。有限金额预算仍只允许可估算的 Workers 文本模型；非 Workers、图片或未知价格的任务会被拒绝。费用记录按配置单价估算，缓存价和附加费用可能与供应商账单不同。</p>
        </details>
        <label><input type="checkbox" disabled={protocol === 'messages'} checked={config[p].supportsJson} onChange={e => edit(p, { supportsJson: e.target.checked })} /> 服务支持协议对应的 JSON 输出约束（不支持时取消，仍会校验 JSON 输出）</label>
        {providerOptionErrors(config[p]).map(detail => <p className="muted" key={detail}>{detail}</p>)}
      </fieldset>; })}
      <SectionCard title="音视频理解模型" detail="现有 Gemini 音视频理解与摘要配置，与文件转录和实时语音转录独立。"><fieldset disabled={!access || busy || !ready}><legend>音视频摘要模型（可选）</legend>
        <p className="muted">与图文模型分开配置，统一模型模式不会覆盖。支持 MP3、WAV、M4A、MP4、WebM，单文件 50 MiB。只生成 AI 摘要；视频同时理解画面与声音。长音频窗口处理会重复计费完整输入。</p>
        <p className="muted">此现有音视频接口使用下方 Google 官方端点；它与仅经 Cloudflare AI Gateway 转发的新语音配置独立。</p>
        <label><input type="checkbox" checked={Boolean(config.mediaUnderstanding)} onChange={e=>{draftRevision.current++;setConfig(c=>({...c,mediaUnderstanding:e.target.checked?{...blank().textEconomy,provider:'openai-compatible',providerPreset:'gemini',apiUrl:'https://generativelanguage.googleapis.com',model:'gemini-2.5-flash',supportsVision:true}:undefined}));setDirty(true);setEdited(true);}} /> 配置音视频摘要模型</label>
        {config.mediaUnderstanding && <>
          <button className="button button-quiet" type="button" disabled={busy||dirty||!version} onClick={()=>void run(async()=>{const result=await call<{passed:boolean;detail:string}>('POST','/media-probe');setMessage(result.detail);if(!result.passed)throw new Error(result.detail);})}>测试音视频模型元数据（不生成）</button>
          <Field label="音视频 Gemini 模型"><input className="input" value={config.mediaUnderstanding.model} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,model:e.target.value}}));draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>
          <Field label="音视频官方端点"><input className="input" readOnly value="https://generativelanguage.googleapis.com" /></Field>
          <Field label="音视频 API key" hint={config.mediaUnderstanding.keyConfigured?'已加密保存，留空保留。':'尚未配置。'}><input className="input" type="password" autoComplete="off" value={config.mediaUnderstanding.apiKey??''} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,apiKey:e.target.value}}));draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>
          {config.mediaUnderstanding.keyConfigured && <label><input type="checkbox" checked={config.mediaUnderstanding.clearKey??false} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,clearKey:e.target.checked}}));draftRevision.current++;setDirty(true);setEdited(true);}} /> 清除音视频密钥</label>}
          {(['timeoutMs','maxOutputTokens'] as const).map(key=><Field key={key} label={key==='timeoutMs'?'音视频超时（毫秒）':'音视频输出 token 上限'}><input className="input" type="number" min={key==='timeoutMs'?1000:1} max={key==='timeoutMs'?600000:undefined} value={config.mediaUnderstanding![key]} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,[key]:Number(e.target.value)}}));draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>)}
          {(['audio','video','text'] as const).map(kind=><Field key={kind} label={`音视频 ${kind} 输入价格（USD / 百万 token）`} hint="按供应商模态单价填写；缺少用量分解或任一模态价格时费用未知。"><input className="input" type="number" min="0" step="0.01" value={config.mediaUnderstanding!.mediaInputPricePerMTokens?.[kind]??''} onChange={e=>{setConfig(c=>({...c,mediaUnderstanding:{...c.mediaUnderstanding!,mediaInputPricePerMTokens:{...c.mediaUnderstanding!.mediaInputPricePerMTokens,[kind]:e.target.value===''?undefined:Number(e.target.value)}}}));draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>)}
          {([0,1] as const).map(index=><Field key={index} label={index===0?'旧输入单价（媒体不采用此值）':'音视频输出价格（USD / 百万 token）'} hint="留空时费用未知，不能据此保证预算上限。"><input className="input" type="number" min="0" step="0.01" value={config.mediaUnderstanding!.pricePerMTokens?.[index]??''} onChange={e=>{setConfig(c=>{const price: [number,number]=[...(c.mediaUnderstanding!.pricePerMTokens??[0,0])];price[index]=Number(e.target.value);return {...c,mediaUnderstanding:{...c.mediaUnderstanding!,pricePerMTokens:e.target.value===''?null:price}};});draftRevision.current++;setDirty(true);setEdited(true);}} /></Field>)}
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
      <p className="muted">保存配置和停用 AI 不发起模型请求，连接测试失败不影响保存。修改配置后会安全停用；未改配置时保留当前启用状态。测试会发起少量真实模型请求，可能产生费用；启用前仍须当前版本全部适用测试通过。key 在后端加密保存，不写入浏览器存储。</p>
      <div className="form-actions"><button className="button button-primary" disabled={!access || busy || !ready} onClick={() => void run(() => save())}>保存配置</button><button className="button button-quiet" disabled={!access || busy || !ready || !version} onClick={() => void run(disable)}>停用 AI</button><button className="button button-primary" disabled={!access || busy || !ready || dirty || !requiredProbes.every(p => reports[p]?.passed && reports[p]?.configVersion === version)} onClick={() => void run(() => save(true))}>全部测试通过后启用 AI</button></div>
      {busy && <p role="status">正在处理，请稍候……</p>}{message && <p role="status">{message}</p>}{Boolean(error) && <ErrorNotice error={error} />}
      <AiDiagnosticsPanel />
    </div>
  </SectionCard>;
}
