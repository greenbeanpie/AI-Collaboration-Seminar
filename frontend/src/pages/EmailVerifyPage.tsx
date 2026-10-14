import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth';
import { ErrorNotice, Field } from '../components/ui';
import { useRecoveryRequest } from './recovery-request';

export function EmailVerifyPage(){
  const [token,setToken]=useState(()=>new URLSearchParams(window.location.hash.slice(1)).get('token')??'');
  const session=useSession(),client=useQueryClient(),request=useRecoveryRequest(session.data?.id??'anonymous');
  const owner=useRef<string|null>(null);
  useEffect(()=>{if(owner.current&&owner.current!==session.data?.id)setToken('');owner.current=session.data?.id??null;},[session.data?.id]);
  useEffect(()=>{if(window.location.hash)window.history.replaceState(window.history.state,'',window.location.pathname);},[]);
  const verify=async()=>{if(await request.run('/api/v1/auth/recovery-email/verify',{token:token.trim()},'恢复邮箱已验证，今后可以通过邮件恢复密码。')){setToken('');void client.invalidateQueries({queryKey:['recovery-email',session.data?.id]});void client.invalidateQueries({queryKey:['session']});}};
  return <main className="content-wrap narrow-page page-stack"><section className="card form-card"><h1>验证恢复邮箱</h1><p>请使用申请绑定邮箱的原账户确认。验证链接15分钟有效，仅可使用一次；密码或邮箱状态变化后失效。</p>{!session.data?<p>请先<Link to="/login">登录原账户</Link>，然后再次打开邮件中的验证链接。</p>:<><p>当前登录：{session.data.username??session.data.displayName}</p><form onSubmit={event=>{event.preventDefault();void verify();}}><fieldset disabled={request.busy}><Field label="邮箱验证代码"><input className="input" autoComplete="off" required maxLength={200} value={token} onChange={event=>setToken(event.target.value)}/></Field><button className="button button-primary" disabled={!request.online}>确认验证恢复邮箱</button></fieldset></form></>}{request.busy&&<button type="button" className="button button-quiet" onClick={request.cancel}>取消等待</button>}{request.message&&<p role="status">{request.message}</p>}{request.error!==null&&<ErrorNotice error={request.error}/>}<Link to="/app/settings/security">查看账户安全设置</Link><Link to="/help">账户帮助</Link></section></main>;
}
