import './AccountSettingsPage.css';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../auth';
import { clearAccountStorage } from '../storage';
import { ErrorNotice, PageHeading } from '../components/ui';

export function AccountSettingsPage() {
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(session.data?.displayName ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const headers = { 'X-Account-Settings': '1' };
  function clearPasswords() { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); setConfirming(false); }
  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const result = await api.patch<'AccountProfileResponse'>('/api/v1/auth/profile', { displayName: name.trim() }, { headers });
      client.setQueryData(['session'], result.user);
      setName(result.user.displayName); setNotice('昵称已保存');
      await client.invalidateQueries({ predicate: query => query.queryKey[0] !== 'session' });
    } catch (failure) { setError(failure); }
    finally { locked.current = false; setBusy(false); }
  }
  function reviewPassword(event: FormEvent) {
    event.preventDefault(); setError(null); setNotice('');
    if (newPassword !== confirmation) { setError(new Error('两次新密码不一致')); return; }
    if (newPassword === currentPassword) { setError(new Error('新密码不能与原密码相同')); return; }
    setConfirming(true);
  }
  async function changePassword() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      await api.post<'AccountPasswordResponse'>('/api/v1/auth/password', { currentPassword, newPassword }, { headers });
      clearPasswords();
      if (session.data) clearAccountStorage(session.data.id);
      client.clear();
      navigate('/login?passwordChanged=1', { replace: true });
    } catch (failure) { clearPasswords(); setError(failure); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="account-settings">
    <PageHeading title="账户设置" detail="管理项目成员看到的昵称和登录密码。" />
    {error !== null && <ErrorNotice error={error} />}
    {notice && <p role="status">{notice}</p>}
    <section className="section-card"><h2>个人资料</h2>
      <p>登录账号：{session.data?.username || session.data?.email || '原有账号'}</p>
      <form onSubmit={event => void saveName(event)}>
        <label>昵称<input className="input" value={name} onChange={event => setName(event.target.value)} required maxLength={64} disabled={busy} autoComplete="nickname" /></label>
        <p>1–64 个字符，修改后同步显示在项目成员中。登录账号保持不变。</p>
        <button className="button button-primary" disabled={busy || !name.trim() || name.trim() === session.data?.displayName}>保存昵称</button>
      </form>
    </section>
    <section className="section-card"><h2>修改密码</h2>
      <p>新密码需 12–128 位，建议使用独特的长密码。成功后所有设备（包括当前设备）退出，请使用新密码登录。</p>
      <form onSubmit={reviewPassword}>
        <label>原密码<input className="input" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required maxLength={128} autoComplete="current-password" disabled={busy || confirming} /></label>
        <label>新密码<input className="input" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" disabled={busy || confirming} /></label>
        <label>确认新密码<input className="input" type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" disabled={busy || confirming} /></label>
        {!confirming && <button className="button button-primary" disabled={busy}>修改密码</button>}
      </form>
      {confirming && <div role="group" aria-label="确认修改密码"><p>确认修改密码并退出全部设备？</p><button className="button button-primary" disabled={busy} onClick={() => void changePassword()}>确认修改并退出</button><button className="button button-quiet" disabled={busy} onClick={() => { clearPasswords(); setError(null); }}>取消</button></div>}
    </section>
  </div>;
}
