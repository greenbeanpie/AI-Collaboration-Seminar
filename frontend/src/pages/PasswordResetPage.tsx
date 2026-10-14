import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { accountRequest } from '../api/simplification';
import { forgetAccount } from '../offline/store';
import { ErrorNotice, Field } from '../components/ui';

export function PasswordResetPage() {
  const [token, setToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null), lock = useRef(false);
  const client = useQueryClient(), navigate = useNavigate();
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
    return () => controller.current?.abort();
  }, []);
  const submit = async () => {
    if (lock.current) return;
    if (password !== confirmation) { setError(new Error('两次新密码不一致')); return; }
    lock.current = true; setBusy(true); setError(null); controller.current = new AbortController();
    try {
      await accountRequest('/api/v1/auth/password-recovery/redeem', { method: 'POST', body: { token: token.trim(), newPassword: password }, networkOnly: true, timeoutMs: 30_000, signal: controller.current.signal });
      setPassword(''); setConfirmation(''); setToken('');
      await client.cancelQueries(); client.clear(); forgetAccount(); navigate('/login?passwordChanged=1', { replace: true });
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setBusy(false); }
  };
  return <main className="content-wrap narrow-page page-stack"><section className="card form-card"><h1>恢复账户密码</h1><p>使用超级管理员人工核实后提供的一次性代码。恢复后所有旧设备会话退出，请使用新密码登录。</p><form onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={busy}><Field label="一次性恢复代码"><input className="input" autoComplete="off" required value={token} maxLength={200} onChange={event => setToken(event.target.value)} /></Field><Field label="新密码" hint="12–128位"><input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></Field><Field label="确认新密码"><input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></Field><button className="button button-primary" disabled={!navigator.onLine}>{busy ? '正在恢复…' : '恢复密码并退出旧设备'}</button></fieldset></form>{busy && <button type="button" className="button button-quiet" onClick={() => controller.current?.abort(new DOMException('已取消等待，服务端结果尚未确认', 'AbortError'))}>取消等待</button>}{error !== null && <><ErrorNotice error={error} /><p>如果请求中断，密码可能已经更新。请先返回登录，使用刚设置的新密码核对；代码已使用时请联系管理员重新核实。</p></>}<Link to="/login">返回登录</Link><Link to="/help">联系管理员</Link></section></main>;
}
