import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession, useCapabilities } from '../auth';
import { accountRequest } from '../api/simplification';
import { ErrorNotice, Field } from '../components/ui';
import { TurnstileChallenge } from '../components/TurnstileChallenge';
import { useRecoveryRequest } from './recovery-request';

export function RecoveryEmailSettings(){
  const session=useSession(),userId=session.data?.id,client=useQueryClient(),capabilities=useCapabilities();
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[token,setToken]=useState(''),[attempt,setAttempt]=useState(0);
  const request=useRecoveryRequest(userId??'anonymous');
  const query=useQuery({queryKey:['recovery-email',userId],enabled:Boolean(userId),networkMode:'always',retry:false,queryFn:({signal})=>accountRequest<{email:string|null;verified:boolean}>('/api/v1/auth/recovery-email',{networkOnly:true,signal})});
  useEffect(()=>{setEmail('');setPassword('');setToken('');setAttempt(0);},[userId]);
  const required=capabilities.data?.authentication?.turnstileRequired===true,key=capabilities.data?.authentication?.turnstileSiteKey;
  const submit=async()=>{const done=await request.run('/api/v1/auth/recovery-email',{email:email.trim(),currentPassword:password,...(required?{turnstileToken:token}:{})},'验证申请已受理。请检查新邮箱，登录此账户后打开15分钟有效的验证链接；验证完成前原恢复邮箱保持有效。');setPassword('');setToken('');setAttempt(value=>value+1);if(done)void query.refetch();};
  const remove=async()=>{if(await request.run('/api/v1/auth/recovery-email',{currentPassword:password},'恢复邮箱已解绑，之前签发的恢复及验证链接均已失效。','DELETE')){setPassword('');await query.refetch();void client.invalidateQueries({queryKey:['session']});}};
  if(!userId)return null;
  return <section className="section-card"><h2>恢复邮箱</h2><p>忘记密码时优先通过已验证邮箱恢复。注册时填写的邮箱需在这里验证后才能用于恢复。</p>{query.data&&!query.error&&<p>当前邮箱：{query.data.email??'未绑定'} · {query.data.verified?'已验证，可用于密码恢复':'尚未验证，不能用于密码恢复'}</p>}{query.error&&<ErrorNotice error={query.error} onRetry={()=>{void query.refetch();
    }}/>}<form onSubmit={event=>{event.preventDefault();void submit();}}><fieldset disabled={request.busy||!query.data||Boolean(query.error)}>
    <Field label="待验证的恢复邮箱"><input className="input" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)}/>
    </Field><Field label="当前密码（核实邮箱操作）"><input className="input" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={event=>setPassword(event.target.value)}/>
    </Field>{required&&key&&<TurnstileChallenge siteKey={key} action="recovery_email" reset={attempt} onToken={setToken} onError={request.setError}/>}<button className="button button-primary" disabled={!request.online||!capabilities.data||Boolean(capabilities.error)||(required&&(!key||!token))}>发送验证邮件</button>{query.data?.email&&<button type="button" className="button button-quiet" disabled={!password||!request.online} onClick={()=>void remove()}>用当前密码解绑恢复邮箱</button>}</fieldset>
    </form>{request.busy&&<button type="button" className="button button-quiet" onClick={request.cancel}>取消等待</button>}{request.message&&<p role="status">{request.message}</p>}{request.error!==null&&<ErrorNotice error={request.error}/>}<button type="button" className="button button-quiet" disabled={query.isFetching||request.busy} onClick={()=>{void query.refetch();
    }}>刷新邮箱验证状态</button></section>;
}
