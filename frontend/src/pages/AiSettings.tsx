import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Field, SectionCard } from '../components/ui';

const purposes = ['textEconomy', 'visionEconomy', 'review'] as const;
type Purpose = typeof purposes[number];
const labels = { textEconomy: '文本与要求提取', visionEconomy: '图片与 OCR', review: '预审与答辩' };
type Model = { provider: string; model: string; apiUrl: string; apiKey?: string; keyConfigured?: boolean; clearKey?: boolean; timeoutMs: number; maxInputChars: number; maxOutputTokens: number; supportsJson: boolean; supportsVision: boolean; pricePerMTokens: [number, number] | null };
type Config = Record<Purpose, Model>;
type Report = { passed: boolean; configVersion: number; checks: { name: string; passed: boolean; detail: string }[] };
const blank = (): Config => Object.fromEntries(purposes.map(p => [p, { provider: 'openai-compatible', model: '', apiUrl: '', apiKey: '', timeoutMs: 90000, maxInputChars: 48000, maxOutputTokens: 4096, supportsJson: true, supportsVision: p === 'visionEconomy', pricePerMTokens: null }])) as Config;

export function AiSettings() {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [config, setConfig] = useState<Config>(blank);
  const [reports, setReports] = useState<Partial<Record<Purpose, Report>>>({});
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/v1/admin/ai-config${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `请求失败 ${response.status}`);
    return result.data as T;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined); setMessage('');
    try { await action(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  function edit(p: Purpose, patch: Partial<Model>) {
    setConfig(c => ({ ...c, [p]: { ...c[p], ...patch } })); setDirty(true); setReports({});
  }
  async function save(enabled: boolean) {
    const data = await call<{ version: number }>('PUT', '', { ...config, enabled });
    setVersion(data.version); setDirty(false); setReports({});
    setConfig(c => Object.fromEntries(purposes.map(p => [p, { ...c[p], keyConfigured: c[p].clearKey ? false : Boolean(c[p].apiKey || c[p].keyConfigured), apiKey: '', clearKey: false }])) as Config);
    setMessage(enabled ? 'AI 已启用，可继续真实业务测试。' : '配置已保存，AI 暂停启用。请逐项测试。');
    await qc.invalidateQueries({ queryKey: ['capabilities'] });
  }
  return <SectionCard title="AI 模型接入与测试" detail="系统级设置，需要运维管理员令牌。API URL、key 和模型名称由你填写；设置影响所有项目。">
    <div className="stack">
      <Field label="管理员令牌" hint="部署时配置的 ADMIN_TOKEN；只在当前页面内存保留。"><input className="input" type="password" autoComplete="off" disabled={busy} value={token} onChange={e => { setToken(e.target.value); setReports({}); }} /></Field>
      <button className="button button-quiet" disabled={!token || busy} onClick={() => void run(async () => {
        const data = await call<{ config: Config; version: number; enabled: boolean }>('GET', '');
        setConfig(data.version ? Object.fromEntries(purposes.map(p => [p, { ...data.config[p], apiKey: '' }])) as Config : blank());
        setVersion(data.version); setDirty(false); setReports({}); setMessage(data.enabled ? '当前 AI 已启用。' : '当前 AI 未启用。');
      })}>读取已保存配置</button>
      {purposes.map(p => <fieldset key={p} className="stack" disabled={busy}><legend>{labels[p]}</legend>
        <Field label={`${labels[p]}供应商`}><select className="input" value={config[p].provider} onChange={e => edit(p, { provider: e.target.value })}><option value="openai-compatible">OpenAI 兼容接口</option><option value="workers-ai">Cloudflare Workers AI（运维配置）</option></select></Field>
        <Field label={`${labels[p]} API URL`} hint="填写完整 HTTPS chat/completions 接口地址。"><input className="input" type="url" autoComplete="off" value={config[p].apiUrl ?? ''} onChange={e => edit(p, { apiUrl: e.target.value.trim() })} /></Field>
        <Field label={`${labels[p]} API key`} hint={config[p].keyConfigured ? '已保存密钥，留空保留；不会回显。' : '尚未填写密钥。'}><input className="input" type="password" autoComplete="off" value={config[p].apiKey ?? ''} onChange={e => edit(p, { apiKey: e.target.value })} /></Field>
        {config[p].keyConfigured && <label><input type="checkbox" checked={config[p].clearKey ?? false} onChange={e => edit(p, { clearKey: e.target.checked })} /> 清除已保存的 key</label>}
        <Field label={`${labels[p]}模型名称`}><input className="input" value={config[p].model} onChange={e => edit(p, { model: e.target.value.trim() })} /></Field>
        <label><input type="checkbox" checked={config[p].supportsJson} onChange={e => edit(p, { supportsJson: e.target.checked })} /> 服务支持 JSON response_format（不支持时取消，仍会校验 JSON 输出）</label>
        <button className="button button-quiet" disabled={!token || busy || dirty || !version} onClick={() => void run(async () => {
          const report = await call<Report>('POST', '/probe', { purpose: p });
          setReports(r => ({ ...r, [p]: report }));
        })}>测试{labels[p]}连接与能力</button>
        {reports[p] && <div role="status"><strong>{reports[p]?.passed ? '测试通过' : '测试失败'} · 配置 v{reports[p]?.configVersion}</strong><ul>{reports[p]?.checks.map(c => <li key={c.name}>{c.passed ? '✓' : '×'} {c.name}：{c.detail}</li>)}</ul></div>}
      </fieldset>)}
      <p className="muted">测试会发起少量真实模型请求，可能产生费用。先保存，再测试三个用途；修改配置后需要重新测试。key 在后端加密保存，不写入浏览器存储。</p>
      <div className="form-actions"><button className="button button-primary" disabled={!token || busy} onClick={() => void run(() => save(false))}>保存配置并停用 AI</button><button className="button button-primary" disabled={!token || busy || dirty || !purposes.every(p => reports[p]?.passed && reports[p]?.configVersion === version)} onClick={() => void run(() => save(true))}>全部测试通过后启用 AI</button></div>
      {busy && <p role="status">正在处理，请稍候……</p>}{message && <p role="status">{message}</p>}{Boolean(error) && <ErrorNotice error={error} />}
    </div>
  </SectionCard>;
}
