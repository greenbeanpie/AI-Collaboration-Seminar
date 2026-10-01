import { useSettingsDirty } from './settings-dirty';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminRequest, useSession } from '../auth';
import { ErrorNotice, Field, SectionCard } from '../components/ui';
import { API_PROTOCOLS, GO_DEFAULT_USER_AGENT, GO_USAGE_NOTICE, PROVIDER_PRESETS, modelCapabilities, presetEndpoint, protocolForConfig, providerOptionErrors, providerPresets, type ApiProtocol, type ProviderOptions, type ProviderPreset } from '../../../shared/ai-providers';

const purposes = ['textEconomy', 'visionEconomy', 'review'] as const;
type Purpose = typeof purposes[number];
type ModelSlot = Purpose | 'unified';
const modelSlots: ModelSlot[] = [...purposes, 'unified'];
const labels = { unified: '统一模型', textEconomy: '文本与要求提取', visionEconomy: '图片与 OCR', review: '预审与答辩' };
type Model = ProviderOptions & { model: string; apiUrl: string; apiKey?: string; keyConfigured?: boolean; clearKey?: boolean; timeoutMs: number; maxInputChars: number; maxOutputTokens: number; supportsJson: boolean; supportsVision: boolean; pricePerMTokens: [number, number] | null };
type Config = Record<ModelSlot, Model> & { routingMode: 'advanced' | 'unified' };
type Report = { passed: boolean; configVersion: number; checks: { name: string; passed: boolean; detail: string }[] };
const blank = (): Config => ({ routingMode: 'unified', ...Object.fromEntries(modelSlots.map(p => [p, { provider: 'openai-compatible', model: '', apiUrl: '', apiKey: '', timeoutMs: 90000, maxInputChars: 48000, maxOutputTokens: 4096, supportsJson: true, supportsVision: p === 'visionEconomy', pricePerMTokens: null }])) }) as Config;

export function AiSettings() {
  const qc = useQueryClient();
  const session = useSession();
  const [token, setToken] = useState('');
  const access = session.data?.role === 'super_admin' || Boolean(token.trim());
  const [config, setConfig] = useState<Config>(blank);
  const [reports, setReports] = useState<Partial<Record<Purpose, Report>>>({});
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(true);
  const [edited, setEdited] = useState(false);
  useSettingsDirty(edited);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return adminRequest<T>(`/api/v1/admin/ai-config${path}`, { method: method as 'GET' | 'POST' | 'PUT', body, token });
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined); setMessage('');
    try { await action(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  function edit(p: ModelSlot, patch: Partial<Model>) {
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
  async function save(enabled: boolean) {
    const data = await call<{ version: number }>('PUT', '', { ...config, enabled, expectedVersion: version });
    setVersion(data.version); setDirty(false); setEdited(false); setReports({});
    setConfig(c => ({ ...c, ...Object.fromEntries(modelSlots.map(p => [p, { ...c[p], keyConfigured: Boolean(c[p].apiKey) || (!c[p].clearKey && Boolean(c[p].keyConfigured)), apiKey: '', clearKey: false }])) }) as Config);
    setMessage(enabled ? 'AI 已启用，可继续真实业务测试。' : '配置已保存，AI 暂停启用。请逐项测试。');
    await qc.invalidateQueries({ queryKey: ['capabilities'] });
  }
  const requiredProbes = config.routingMode === 'unified' && !config.unified.supportsVision ? purposes.filter(p => p !== 'visionEconomy') : purposes;
  return <SectionCard title="AI 模型接入与测试" detail="系统级设置，使用超级管理员账户登录即可管理。API URL、key 和模型名称由你填写；设置影响所有项目。">
    <div className="stack">
      {session.data?.role !== 'super_admin' && <p className="muted">需要超级管理员权限；项目负责人可请系统管理员配置，或使用下方运维令牌模式。</p>}
      <details><summary>运维管理员令牌模式（可选）</summary><Field label="管理员令牌" hint="部署时配置的 ADMIN_TOKEN；只在当前页面内存保留。"><input className="input" type="password" autoComplete="off" disabled={busy} value={token} onChange={e => { setToken(e.target.value); setEdited(true); setReports({}); setError(undefined); setMessage(''); }} /></Field></details>
      <button className="button button-quiet" disabled={!access || busy} onClick={() => void run(async () => {
        const data = await call<{ config: Config; version: number; enabled: boolean }>('GET', '');
        setConfig(data.version ? { routingMode: data.config.routingMode ?? 'advanced', ...Object.fromEntries(modelSlots.map(p => [p, { ...(data.config[p] ?? blank()[p]), apiKey: '' }])) } as Config : blank());
        setVersion(data.version); setDirty(false); setEdited(false); setReports({}); setMessage(data.enabled ? '当前 AI 已启用。' : '当前 AI 未启用。');
      })}>读取已保存配置</button>
      <Field label="模型路由模式"><select className="input" disabled={busy} value={config.routingMode} onChange={e => { setConfig(c => ({ ...c, routingMode: e.target.value as Config['routingMode'] })); setDirty(true); setEdited(true); setReports({}); }}><option value="unified">统一模型（推荐）</option><option value="advanced">高级：按用途配置</option></select></Field>
      <p className="muted">统一模式让提取、评价、拆解、分配和对话使用同一模型配置；高级配置草稿会保留。切换模式后需保存并重新测试。模型不支持图片时，图片任务会明确失败，不会自动改用其他端点。</p>
      {config.routingMode === 'unified' && !config.unified.supportsVision && <p role="note">当前统一模型未声明图片支持：图片 / OCR 不可用；文本功能可在文本与评价测试通过后启用。</p>}
      {(config.routingMode === 'unified' ? ['unified'] as const : purposes).map(p => { const caps = modelCapabilities(config[p]); const preset = config[p].providerPreset ?? 'custom'; const protocol = protocolForConfig(config[p]); return <fieldset key={p} className="ai-model-settings" disabled={busy}><legend>{labels[p]}</legend>
        <Field label={`${labels[p]}供应商`} hint="选择预设只填入建议地址和模型；不会启用 AI 或发出请求。自定义保留现有兼容接口。"><select className="input" value={config[p].provider === 'workers-ai' ? 'workers-ai' : preset} onChange={e => choosePreset(p, e.target.value)}>{PROVIDER_PRESETS.map(id => <option key={id} value={id}>{providerPresets[id].label}</option>)}<option value="workers-ai">Cloudflare Workers AI（运维配置）</option></select></Field>
        {preset === 'opencode-go' && <div role="note"><p>{GO_USAGE_NOTICE} <a href="https://opencode.ai/docs/go/#where-can-i-use-it" target="_blank" rel="noreferrer">官方使用说明</a></p><label><input type="checkbox" checked={config[p].goUsageAcknowledged ?? false} onChange={e => edit(p, { goUsageAcknowledged: e.target.checked })} /> 我已确认套餐适用于本应用用途</label><p className="muted">使用本应用真实 User-Agent 和稳定会话 ID；不模拟官方客户端，不绕过服务限制。</p><fieldset><legend>OpenCode Go 专用请求头</legend><Field label={`${labels[p]} Go User-Agent`} hint="仅填写你实际应用的名称/版本；不能填写官方客户端身份或密钥。"><input className="input" value={config[p].goHeaders?.userAgent ?? GO_DEFAULT_USER_AGENT} onChange={e => edit(p, { goHeaders: { ...config[p].goHeaders, userAgent: e.target.value } })} /></Field><Field label={`${labels[p]} Go 会话前缀`} hint="x-opencode-session 默认自动按会话/任务生成，重试保持一致。可选非敏感前缀；不填 key、姓名或用户资料。"><input className="input" maxLength={32} value={config[p].goHeaders?.sessionPrefix ?? ''} onChange={e => edit(p, { goHeaders: { ...config[p].goHeaders, sessionPrefix: e.target.value } })} /></Field><p className="muted">鉴权头由后端密钥生成，不允许编辑 Authorization、x-api-key、Cookie、Host 或任意请求头。</p></fieldset></div>}
        <Field label={`${labels[p]} API 协议`} hint="协议可手动选择；预设给出推荐值，已核实不兼容的组合会明确拒绝。"><select className="input" value={protocol} disabled={config[p].provider === 'workers-ai'} onChange={e => { const apiProtocol = e.target.value as ApiProtocol; edit(p, { apiProtocol, ...(preset !== 'custom' ? { apiUrl: presetEndpoint(preset, config[p].model, apiProtocol) } : {}), supportsJson: apiProtocol === 'messages' ? false : config[p].supportsJson }); }}>{API_PROTOCOLS.map(style => <option key={style} value={style}>{style}</option>)}</select></Field>
        <Field label={`${labels[p]} API URL`} hint="完整 HTTPS 请求地址，不能含密钥或查询参数；修改地址需重新输入 key 或清除旧 key。"><input className="input" type="url" autoComplete="off" value={config[p].apiUrl ?? ''} onChange={e => edit(p, { apiUrl: e.target.value.trim() })} /></Field>
        <Field label={`${labels[p]} API key`} hint={config[p].keyConfigured ? '已保存密钥，留空保留；不会回显。' : '尚未填写密钥。'}><input className="input" type="password" autoComplete="off" value={config[p].apiKey ?? ''} onChange={e => edit(p, { apiKey: e.target.value })} /></Field>
        {config[p].keyConfigured && <label><input type="checkbox" checked={config[p].clearKey ?? false} onChange={e => edit(p, { clearKey: e.target.checked })} /> 清除已保存的 key</label>}
        <Field label={`${labels[p]}模型名称`}><input className="input" value={config[p].model} list={`models-${p}`} onChange={e => chooseModel(p, e.target.value.trim())} /></Field>
        <datalist id={`models-${p}`}>{providerPresets[preset].models.map(model => <option key={model} value={model} />)}</datalist>
        <Field label={`${labels[p]}思考强度`} hint={caps.reasoning.length ? '默认不发送该参数，沿用供应商默认值；各模型可选范围不同。' : '此模型未核实思考参数支持，保持默认，不发送参数。'}><select className="input" value={config[p].reasoningEffort ?? ''} onChange={e => changeEffort(p, e.target.value as Model['reasoningEffort'] | '')}><option value="">默认（不发送）</option>{caps.reasoning.map(effort => <option key={effort} value={effort}>{effort}</option>)}{config[p].reasoningEffort && !caps.reasoning.includes(config[p].reasoningEffort!) && <option value={config[p].reasoningEffort}>不支持：{config[p].reasoningEffort}</option>}</select></Field>
        <details><summary>常用参数与调用上限</summary>
          <Field label={`${labels[p]} temperature`} hint={caps.temperature ? '0–2；留空不发送。通常与 top_p 二选一。' : preset === 'gemini' ? '按官方建议使用默认采样，请留空。' : '此模型/思考模式不支持；请留空。'}><input className="input" type="number" min="0" max="2" step="0.1" value={config[p].temperature ?? ''} onChange={e => edit(p, { temperature: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]} top_p`} hint={caps.topP ? `${caps.minTopP}–1；留空不发送。` : preset === 'gemini' ? '按官方建议使用默认采样，请留空。' : '此模型/思考模式未核实支持；请留空。'}><input className="input" type="number" min={caps.minTopP} max="1" step="0.01" value={config[p].topP ?? ''} onChange={e => edit(p, { topP: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}最大输出 token`} hint="1–32768，含义以供应商协议为准；不等于实际费用上限。"><input className="input" type="number" min="1" max="32768" value={config[p].maxOutputTokens} onChange={e => edit(p, { maxOutputTokens: Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}超时（毫秒）`}><input className="input" type="number" min="1000" max="600000" step="1000" value={config[p].timeoutMs} onChange={e => edit(p, { timeoutMs: Number(e.target.value) })} /></Field>
          <Field label={`${labels[p]}最大输入字符`}><input className="input" type="number" min="1" value={config[p].maxInputChars} onChange={e => edit(p, { maxInputChars: Number(e.target.value) })} /></Field>
          <label><input type="checkbox" checked={config[p].supportsVision} onChange={e => edit(p, { supportsVision: e.target.checked })} /> 声明模型支持图片输入（仍需探测）</label>
          <p className="muted">业务请求保留最多两次调用（首次 + 一次修复/可重试错误），不自动换模型。有限金额预算仍只允许可估算的 Workers 文本模型；非 Workers、图片或未知价格的任务会被拒绝。费用记录按配置单价估算，缓存价和附加费用可能与供应商账单不同。</p>
        </details>
        <label><input type="checkbox" disabled={protocol === 'messages'} checked={config[p].supportsJson} onChange={e => edit(p, { supportsJson: e.target.checked })} /> 服务支持协议对应的 JSON 输出约束（不支持时取消，仍会校验 JSON 输出）</label>
        {providerOptionErrors(config[p]).map(detail => <p className="muted" key={detail}>{detail}</p>)}
      </fieldset>; })}
      <div className="form-actions">{requiredProbes.map(p => <div key={p}>
        <button className="button button-quiet" disabled={!access || busy || dirty || !version} onClick={() => void run(async () => {
          const report = await call<Report>('POST', '/probe', { purpose: p });
          setReports(r => ({ ...r, [p]: report }));
        })}>测试{labels[p]}（连接与能力）</button>
        {reports[p] && <div role="status"><strong>{reports[p]?.passed ? '测试通过' : '测试失败'} · 配置 v{reports[p]?.configVersion}</strong><ul>{reports[p]?.checks.map(c => <li key={c.name}>{c.passed ? '✓' : '✗'} {c.name}：{c.detail}</li>)}</ul></div>}
      </div>)}</div>
      <p className="muted">测试会发起少量真实模型请求，可能产生费用。先保存，再测试当前模式的可用用途；修改配置后需要重新测试。key 在后端加密保存，不写入浏览器存储。</p>
      <div className="form-actions"><button className="button button-primary" disabled={!access || busy || (config.routingMode === 'unified' ? ['unified'] as const : purposes).some(p => providerOptionErrors(config[p]).length > 0)} onClick={() => void run(() => save(false))}>保存配置并停用 AI</button><button className="button button-primary" disabled={!access || busy || dirty || !requiredProbes.every(p => reports[p]?.passed && reports[p]?.configVersion === version)} onClick={() => void run(() => save(true))}>全部测试通过后启用 AI</button></div>
      {busy && <p role="status">正在处理，请稍候……</p>}{message && <p role="status">{message}</p>}{Boolean(error) && <ErrorNotice error={error} />}
    </div>
  </SectionCard>;
}
