import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCapabilities } from '../auth';
import { ErrorNotice, Field } from '../components/ui';
import { TurnstileChallenge } from '../components/TurnstileChallenge';
import { useRecoveryRequest } from './recovery-request';

export function PasswordForgotPage(){
  const [account,setAccount]=useState(''),[token,setToken]=useState(''),[attempt,setAttempt]=useState(0);
  const capabilities=useCapabilities(),request=useRecoveryRequest();
  const required=capabilities.data?.authentication?.turnstileRequired===true,key=capabilities.data?.authentication?.turnstileSiteKey;
  const submit=async()=>{await request.run('/api/v1/auth/password-recovery/request',{account:account.trim(),...(required?{turnstileToken:token}:{})},'申请已受理。若账户已绑定并验证恢复邮箱，将收到30分钟有效的恢复链接。请检查垃圾邮件；未验证邮箱无法用于恢复，可联系管理员人工核实。');setToken('');setAttempt(value=>value+1);};
  return <main className="content-wrap narrow-page page-stack"><section className="card form-card"><h1>邮件恢复密码</h1>
    <p>请输入登录用户名或已验证的恢复邮箱。系统不会向注册时填写但未验证的邮箱发送恢复链接。</p><form onSubmit={event=>{event.preventDefault();
    void submit();}}><fieldset disabled={request.busy}><Field label="用户名或已验证邮箱"><input className="input" autoComplete="username" required maxLength={254} value={account} onChange={event=>setAccount(event.target.value)}/>
    </Field>{required&&key&&<TurnstileChallenge siteKey={key} action="password_recovery" reset={attempt} onToken={setToken} onError={request.setError}/>}<button className="button button-primary" disabled={!request.online||!capabilities.data||Boolean(capabilities.error)||(required&&(!key||!token))}>{request.busy?'正在提交…':'申请恢复邮件'}</button>
    </fieldset></form>{request.busy&&<button className="button button-quiet" type="button" onClick={request.cancel}>取消等待</button>}{request.message&&<p role="status">{request.message}</p>}{request.error!==null&&<ErrorNotice error={request.error}/>} {capabilities.error&&<ErrorNotice error={capabilities.error} onRetry={()=>{void capabilities.refetch();
    }}/>}<p>请求中断时邮件可能已经发出，请先检查收件箱，系统不会自动重发。</p><Link to="/help">无法使用邮箱？联系管理员</Link><Link to="/login">返回登录</Link>
    </section></main>;
}
