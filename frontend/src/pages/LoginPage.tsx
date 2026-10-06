import { BrandMark } from '../components/BrandMark';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import type { Capability, User } from '../api/types';
import { useCapabilities } from '../auth';
import { ErrorNotice, Field, Spinner } from '../components/ui';
import { TurnstileChallenge } from '../components/TurnstileChallenge';
import { ThemeSelector } from '../components/ThemeSelector';

type Props = { capabilities?: Capability; capabilityError?: unknown; onRetryCapabilities?: () => unknown };

export function LoginPage(props: Props) {
  const capabilityQuery = useCapabilities();
  const capabilities = props.capabilities ?? capabilityQuery.data;
  const capabilityError = props.capabilityError ?? capabilityQuery.error;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [account, setAccount] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const turnstileRequired = capabilities?.authentication?.turnstileRequired === true;
  const turnstileSiteKey = capabilities?.authentication?.turnstileSiteKey;
  const minPasswordLength = capabilities?.authentication?.passwordMinLength ?? 12;
  const authenticationUnavailable = capabilities?.authentication?.passwordEnabled === false;
  const authenticate = useMutation({
    mutationFn: async () => {
      if (authenticationUnavailable) throw new Error('密码登录服务尚未启用，请联系系统管理员。');
      if (!capabilities) throw new Error('请等待系统能力加载完成后重试。');
      if (turnstileRequired && (!turnstileSiteKey || !turnstileToken)) throw new Error('请先完成人机验证。');
      const challenge = turnstileRequired ? { turnstileToken } : {};
      if (mode === 'register') {
        if (!/^[A-Za-z0-9_-]{3,32}$/.test(username.trim())) throw new Error('用户名须为 3–32 位字母、数字、下划线或连字符。');
        if (password.length < minPasswordLength || password.length > 128) throw new Error(`密码须为 ${minPasswordLength}–128 位。`);
        if (!/^[A-Za-z0-9]{16}$/.test(invitationCode.trim())) throw new Error('请输入管理员提供的 16 位注册邀请码。');
        return api.post<'AuthSessionResponse'>('/api/v1/auth/register', { ...challenge, username: username.trim(), password, invitationCode: invitationCode.trim(), ...(email.trim() ? { email: email.trim() } : {}) });
      }
      if (!account.trim() || !password) throw new Error('请输入账号与密码。');
      return api.post<'AuthSessionResponse'>('/api/v1/auth/sessions', { ...challenge, account: account.trim(), password });
    },
    onSuccess: (result) => {
      setPassword(''); setInvitationCode(''); setError(null);
      queryClient.setQueryData(['session'], result.user as User);
      const returnTo = searchParams.get('returnTo');
      // Only the bridge's local pairing route is an allowed login continuation.
      navigate(returnTo && /^\/app\/agent-bridges\/connect\?pairing=[a-zA-Z0-9-]+$/.test(returnTo) ? returnTo : '/app', { replace: true });
    },
    onError: setError,
    onSettled: () => { setTurnstileToken(''); setChallengeAttempt(attempt => attempt + 1); },
  });
  function switchMode(next: 'login' | 'register') {
    setTurnstileToken(''); setChallengeAttempt(attempt => attempt + 1); setMode(next); setPassword(''); setInvitationCode(''); setError(null);
  }
  return <main className="auth-page">
    <div className="auth-orb orb-one" /><div className="auth-orb orb-two" />
    <header className="auth-top"><Link to="/" className="brand"><span className="brand-mark"><BrandMark/></span><span className="brand-copy"><strong>补位</strong><small>AI 项目办公室</small></span></Link><div className="auth-top-actions"><ThemeSelector/><a href="/guest/index.html" className="button button-quiet">游客演示 <ArrowUpRight size={16} /></a></div></header>
    <div className="auth-layout">
      <section className="auth-intro"><span className="intro-badge"><span className="pulse-dot" />真实项目工作区</span><h1>让协作过程<br /><em>清楚、有据、能交接</em></h1><p>从通知要求到团队任务、材料版本与过程记录，让每一步都留在真实项目里。</p><div className="intro-checks"><span><ShieldCheck size={17} /> 项目数据由服务端保存</span><span><ShieldCheck size={17} /> AI 内容须人工复核后采纳</span></div></section>
      <section className="auth-card">
        <div className="auth-card-top"><div className="auth-icon"><KeyRound size={21} /></div><span className="eyebrow">账号密码 · 邀请注册</span></div>
        <div className="auth-tabs" role="tablist" aria-label="登录或注册"><button type="button" role="tab" id="login-tab" aria-controls="auth-panel" aria-selected={mode === 'login'} disabled={authenticate.isPending} onClick={() => switchMode('login')}>登录</button><button type="button" role="tab" id="register-tab" aria-controls="auth-panel" aria-selected={mode === 'register'} disabled={authenticate.isPending} onClick={() => switchMode('register')}>注册</button></div>
        <div role="tabpanel" id="auth-panel" aria-labelledby={mode === 'login' ? 'login-tab' : 'register-tab'}>
          <h2>{mode === 'login' ? '欢迎回来' : '创建协作账户'}</h2><p className="auth-subtitle">{mode === 'login' ? '使用用户名或已绑定邮箱与密码登录。' : '注册需要系统管理员提供的单次邀请码；邮箱可选。'}</p>
          {capabilityError !== null && capabilityError !== undefined && <ErrorNotice error={capabilityError} onRetry={() => { void (props.onRetryCapabilities ?? capabilityQuery.refetch)(); }} />}
          {authenticationUnavailable && <p role="alert">密码登录服务尚未启用，请联系系统管理员。</p>}
          {searchParams.get('localLogout') === '1' && <p role="status">已退出本机工作区；离线时无法撤销服务端会话，请联网后重新登录并退出。</p>}
          {searchParams.get('passwordChanged') === '1' && <p role="status">密码已修改，全部设备已退出。请使用新密码登录。</p>}
      <form onSubmit={(event) => { event.preventDefault(); if (!authenticate.isPending) { setError(null); authenticate.mutate(); } }}>
            <fieldset className="auth-fields" disabled={authenticate.isPending}>
              {mode === 'login' ? <Field label="用户名或邮箱"><input className="input" name="account" autoComplete="username" required maxLength={254} placeholder="输入用户名或邮箱" value={account} onChange={event => setAccount(event.target.value)} /></Field> : <>
                <Field label="用户名" hint="3–32 位字母、数字、下划线或连字符。"><input className="input" name="username" autoComplete="username" pattern={'[A-Za-z0-9_\\-]{3,32}'} required maxLength={32} placeholder="例如 team_member" value={username} onChange={event => setUsername(event.target.value)} /></Field>
                <Field label="邮箱地址（选填）"><input className="input" name="email" autoComplete="email" type="email" maxLength={254} placeholder="name@example.com" value={email} onChange={event => setEmail(event.target.value)} /></Field>
              </>}
              <Field label="密码" hint={mode === 'register' ? `${minPasswordLength}–128 位；请使用独立密码并妥善保存。` : undefined}><input className="input" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? minPasswordLength : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></Field>
              {mode === 'register' && <Field label="16 位注册邀请码" hint="由系统管理员提供，成功注册后即失效；与项目邀请不同。"><input className="input code-input" name="invitationCode" autoComplete="off" pattern="[A-Za-z0-9]{16}" minLength={16} maxLength={16} required value={invitationCode} onChange={event => setInvitationCode(event.target.value.trim())} /></Field>}
              {turnstileRequired && (turnstileSiteKey ? <TurnstileChallenge key={mode} siteKey={turnstileSiteKey} action={mode} reset={challengeAttempt} onToken={setTurnstileToken} onError={setError} /> : <p role="alert">人机验证尚未配置，请联系系统管理员。</p>)}
              <button className="button button-primary button-wide" type="submit" disabled={authenticationUnavailable || !capabilities || (turnstileRequired && !turnstileToken)}>{authenticate.isPending ? <Spinner label={mode === 'login' ? '正在登录' : '正在注册'} /> : mode === 'login' ? '登录工作区' : '注册并登录'}</button>
            </fieldset>
          </form>
          {error !== null && <ErrorNotice error={error} />}
        </div>
        <div className="auth-footnote">请妥善保管密码与注册邀请码。加入项目后，根据团队约定标注材料来源与贡献。</div>
      </section>
    </div>
    <footer className="auth-footer"><span>「补位」AI 项目办公室</span><span>请以官方平台要求为准，产品中的预审结果仅供协作参考。</span></footer>
  </main>;
}
