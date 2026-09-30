import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Mail, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import type { Capability } from '../api/types';
import { useCapabilities } from '../auth';
import { ErrorNotice, Field, Spinner } from '../components/ui';

type Props = { capabilities?: Capability; capabilityError?: unknown; onRetryCapabilities?: () => unknown };

export function LoginPage(props: Props) {
  const capabilityQuery = useCapabilities();
  const capabilities = props.capabilities ?? capabilityQuery.data;
  const capabilityError = props.capabilityError ?? capabilityQuery.error;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [resendSeconds, setResendSeconds] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [challengeError, setChallengeError] = useState<unknown>(null);
  const [loginError, setLoginError] = useState<unknown>(null);
  const localEcho = capabilities?.environment === 'local' && capabilities.features.emailMode === 'echo';

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => setResendSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  const sendChallenge = useMutation({
    mutationFn: () => api.post<'AuthChallengeResponse'>('/api/v1/auth/challenges', { email: email.trim() }),
    onSuccess: (result) => {
      setChallengeId(result.challengeId);
      setDevCode(result.devCode ?? undefined);
      setResendSeconds(result.resendAfterSeconds);
      setCode(''); setFeedback(localEcho && result.devCode ? '本地验证码已生成。' : '验证码已发送，请检查邮箱。'); setChallengeError(null);
    },
    onError: (error) => { setChallengeError(error); setFeedback(''); },
  });
  const signIn = useMutation({
    mutationFn: () => api.post<'AuthSessionResponse'>('/api/v1/auth/sessions', { email: email.trim(), challengeId, code: code.trim() }),
    onSuccess: async () => {
      setLoginError(null);
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await queryClient.refetchQueries({ queryKey: ['session'], type: 'active' });
      navigate('/app', { replace: true });
    },
    onError: setLoginError,
  });

  return <main className="auth-page">
    <div className="auth-orb orb-one" /><div className="auth-orb orb-two" />
    <header className="auth-top"><Link to="/" className="brand"><span className="brand-mark">补</span><span className="brand-copy"><strong>补位</strong><small>AI 项目办公室</small></span></Link><a href="/guest/index.html" className="button button-quiet">游客演示 <ArrowUpRight size={16} /></a></header>
    <div className="auth-layout">
      <section className="auth-intro"><span className="intro-badge"><span className="pulse-dot" />真实项目工作区</span><h1>让协作过程<br /><em>清楚、有据、能交接</em></h1><p>从通知要求到团队任务、材料版本与过程记录，让每一步都留在真实项目里。</p><div className="intro-checks"><span><ShieldCheck size={17} /> 项目数据由服务端保存</span><span><ShieldCheck size={17} /> AI 内容须人工复核后采纳</span></div></section>
      <section className="auth-card">
        <div className="auth-card-top"><div className="auth-icon"><Mail size={21} /></div><span className="eyebrow">邮箱验证登录</span></div>
        <h2>欢迎回来</h2><p className="auth-subtitle">输入邮箱获取一次性验证码；首次登录会创建账户。</p>
        {capabilityError !== null && capabilityError !== undefined && <ErrorNotice error={capabilityError} onRetry={() => { void (props.onRetryCapabilities ?? capabilityQuery.refetch)(); }} />}
        <form onSubmit={(event) => { event.preventDefault(); if (challengeId) { setLoginError(null); signIn.mutate(); } else { setChallengeError(null); sendChallenge.mutate(); } }}>
          <Field label="邮箱地址"><input className="input" autoComplete="email" type="email" required maxLength={254} placeholder="name@example.com" value={email} onChange={(event) => { setEmail(event.target.value); setChallengeId(''); setCode(''); setDevCode(undefined); setFeedback(''); setLoginError(null); }} /></Field>
          {!challengeId ? <button className="button button-primary button-wide" type="submit" disabled={sendChallenge.isPending}>{sendChallenge.isPending ? <Spinner label="正在发送" /> : '获取验证码'}</button> : <>
            <Field label="6 位验证码" hint="验证码仅能使用一次，过期后需要重新获取。"><input className="input code-input" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></Field>
            {localEcho && devCode && <div className="local-echo"><span className="local-echo-label">本地验证码回显</span><strong>{devCode}</strong><small>仅本地 echo 邮件模式提供；生产环境不会返回验证码。</small></div>}
            <button className="button button-primary button-wide" type="submit" disabled={signIn.isPending || code.length !== 6}>{signIn.isPending ? <Spinner label="正在验证" /> : '验证并登录'}</button>
            <button type="button" className="text-button resend-button" disabled={resendSeconds > 0 || sendChallenge.isPending} onClick={() => sendChallenge.mutate()}>{resendSeconds > 0 ? `${resendSeconds} 秒后可重新发送` : '重新发送验证码'}</button>
          </>}
        </form>
        {feedback && <div className="notice notice-success">{feedback}</div>}
        {challengeError !== null && <ErrorNotice error={challengeError} />}
        {loginError !== null && <ErrorNotice error={loginError} />}
        <div className="auth-footnote">请妥善保管邮箱验证码。加入项目后，根据团队约定标注材料来源与贡献。</div>
      </section>
    </div>
    <footer className="auth-footer"><span>「补位」AI 项目办公室</span><span>请以官方平台要求为准，产品中的预审结果仅供协作参考。</span></footer>
  </main>;
}
