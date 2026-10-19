import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../auth';
import { loginContinuation } from '../auth-continuation';
import { apiUrl, fetchWithTimeout } from '../api/client';
import { ErrorNotice, Spinner } from '../components/ui';

type AuthorizationInfo = { state: string; expiresAt: string; clientType?: 'android' | 'windows'; callbackBase?: string };
const callbackBases = { android: 'buwei-native-preview://auth/callback', windows: 'buwei-windows-native://auth/callback' };
function callbackBase(info: AuthorizationInfo): string {
  if (info.clientType !== undefined && info.clientType !== 'android' && info.clientType !== 'windows') throw new Error('应用回调地址不匹配，请重新登录。');
  const base = callbackBases[info.clientType ?? 'android'];
  if (!base || (info.callbackBase !== undefined && info.callbackBase !== base)) throw new Error('应用回调地址不匹配，请重新登录。');
  return base;
}

async function authorizationRequest<T>(path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  const { response } = await fetchWithTimeout(apiUrl(path), { method, credentials: 'same-origin', cache: 'no-store' }, { signal, timeoutMs: 15_000 });
  const body = await response.json() as { data: T; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '无法读取原生登录请求，请从应用重新登录。');
  return body.data;
}

/** Only browser authentication is used here; native clients retain their own business screens. */
export function NativeAuthorizePage() {
  const [params] = useSearchParams();
  const transaction = params.get('transaction') ?? '';
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transaction);
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [callback, setCallback] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  const info = useQuery({ queryKey: ['native-authorization', transaction, session.data?.id], enabled: valid && Boolean(session.data), retry: false, networkMode: 'always', queryFn: async ({ signal }) => {
    const data = await authorizationRequest<AuthorizationInfo>(`/api/v1/auth/native/transactions/${transaction}`, 'GET', signal);
    callbackBase(data);
    return data;
  } });
  const cancelUri = info.data ? `${callbackBase(info.data)}?error=access_denied&state=${encodeURIComponent(info.data.state)}` : null;
  async function approve() {
    if (busy || callback || !info.data) return;
    setBusy(true); setError(null);
    try {
      const result = await authorizationRequest<{ redirectUri: string }>(`/api/v1/auth/native/transactions/${transaction}/approve`, 'POST');
      const uri = new URL(result.redirectUri);
      const expected = new URL(callbackBase(info.data));
      if (uri.protocol !== expected.protocol || uri.host !== expected.host || uri.pathname !== expected.pathname || uri.username || uri.password || uri.hash || uri.searchParams.get('state') !== info.data.state || !/^[A-Za-z0-9_-]{43}$/.test(uri.searchParams.get('code') ?? '') || uri.searchParams.getAll('state').length !== 1 || uri.searchParams.getAll('code').length !== 1 || [...uri.searchParams.keys()].some(key => key !== 'state' && key !== 'code')) throw new Error('应用回调地址不匹配，请重新登录。');
      setCallback(result.redirectUri);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  return <main className="page"><section className="card"><h1>{info.data?.clientType === 'windows' ? '登录补位 Windows 客户端' : '登录补位原生预览'}</h1>
    <p>仅在你刚刚从补位原生应用发起登录时确认。确认后，该应用将获得独立的账户会话。</p>
    {!valid ? <p role="alert">登录请求格式无效，请从原生应用重新登录。</p> : <>
      {session.isPending && <Spinner label="正在检查登录账户" />}
      {session.error && <ErrorNotice error={session.error} />}
      {session.data === null && <Link className="button button-primary" to={loginContinuation(`/app/native-authorize?transaction=${transaction}`)}>先登录浏览器账户</Link>}
      {session.data && <p>当前账户：<strong>{session.data.username ?? session.data.displayName}</strong></p>}
      {info.isFetching && <Spinner label="正在检查授权请求" />}
      {info.error && <ErrorNotice error={info.error} />}
      {info.data && !callback && !cancelled && <><p>请求有效至 {new Date(info.data.expiresAt).toLocaleTimeString()}。应用可访问你已有权限的项目和资料。</p><button className="button button-primary" disabled={busy} onClick={() => { void approve(); }}>{busy ? '正在确认…' : '确认登录此账户'}</button><button className="button button-quiet" disabled={busy} onClick={() => setCancelled(true)}>取消</button></>}
      {error !== null && <><ErrorNotice error={error} /><p>如果确认结果不明，请从原生应用重新发起登录。</p></>}
      {callback && <><p role="status">授权已确认，请在一分钟内返回应用完成登录。</p><a className="button button-primary" href={callback} rel="noreferrer">{info.data?.clientType === 'windows' ? '返回补位 Windows 客户端' : '返回补位原生预览'}</a></>}
      {cancelled && <><p role="status">已取消登录。</p>{cancelUri && <a className="button" href={cancelUri} rel="noreferrer">返回应用</a>}</>}
    </>}
    <p><Link to="/app">返回工作台</Link></p>
  </section></main>;
}
