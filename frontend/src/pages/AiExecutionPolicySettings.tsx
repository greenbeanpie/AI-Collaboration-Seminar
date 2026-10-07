import { useEffect, useRef, useState } from 'react';
import { adminRequest } from '../auth';
import { ErrorNotice, Field, SectionCard } from '../components/ui';
import { useSettingsDirty } from './settings-dirty';
type Policy = { version: number; maxModelCalls: number };
export function AiExecutionPolicySettings({ access, token }: { access: boolean; token: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null), [value, setValue] = useState('100'), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const dirty = policy !== null && value !== String(policy.maxModelCalls);
  useSettingsDirty(dirty);
  useEffect(() => { let active = true; setPolicy(null); setError(null); if (access) void adminRequest<Policy>('/api/v1/admin/ai-execution-policy', { token }).then(next => { if (active) { setPolicy(next); setValue(String(next.maxModelCalls)); } }).catch(reason => { if (active) setError(reason); }); return () => { active = false; }; }, [access, token]);
  const load = async () => { const next = await adminRequest<Policy>('/api/v1/admin/ai-execution-policy', { token }); setPolicy(next); setValue(String(next.maxModelCalls)); };
  const run = async (action: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(null); setSaved(false); try { await action(); } catch (reason) { setError(reason); } finally { lock.current = false; setBusy(false); } };
  return <SectionCard title="后台 AI 执行策略" detail="每个处理窗口达到上限后保存进度并暂停，用户可继续处理；累计轮次没有固定上限。策略与模型配置独立，修改后在新窗口生效。"><Field label="每窗口模型调用上限"><input type="number" className="input" min={1} max={10000} step={1} value={value} disabled={!access || !policy || busy} onChange={event => { setValue(event.target.value); setSaved(false); }} /></Field><p className="muted">默认 100 次，允许 1–10000 的整数。{policy && ` 执行策略 v${policy.version}`}</p><div className="form-actions"><button className="button button-primary" disabled={!access || !policy || busy || !dirty} onClick={() => void run(async () => { const maxModelCalls = Number(value); if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 10000) throw new Error('调用上限需要是 1–10000 的整数。'); const next = await adminRequest<Policy>('/api/v1/admin/ai-execution-policy', { method: 'PUT', token, body: { expectedVersion: policy!.version, maxModelCalls } }); setPolicy(next); setValue(String(next.maxModelCalls)); setSaved(true); })}>保存执行策略</button><button className="button button-quiet" disabled={!access || busy} onClick={() => void run(load)}>重新读取执行策略</button></div>{saved && <p role="status">执行策略已保存，将在新处理窗口生效。</p>}{error !== null && <ErrorNotice error={error} />}</SectionCard>;
}
