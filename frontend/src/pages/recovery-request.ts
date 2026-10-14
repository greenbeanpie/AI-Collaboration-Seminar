import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest } from '../api/simplification';
import { ApiError } from '../api/client';

/** An interrupted send may already have sent email; never replay it automatically. */
export function useRecoveryRequest(context = 'public') {
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[message,setMessage]=useState('');
  const [online,setOnline]=useState(navigator.onLine);
  const current=useRef(context);current.current=context;
  const controller=useRef<AbortController|null>(null),lock=useRef(false),mounted=useRef(true),epoch=useRef(0);
  const invalidate=useCallback(()=>{mounted.current=false;epoch.current++;controller.current?.abort();},[]);
  useEffect(()=>{mounted.current=true;setBusy(false);setError(null);setMessage('');return invalidate;},[context,invalidate]);
  useEffect(()=>{const changed=()=>setOnline(navigator.onLine);window.addEventListener('online',changed);window.addEventListener('offline',changed);return()=>{window.removeEventListener('online',changed);window.removeEventListener('offline',changed);};},[]);
  const run=async(path:string,body:unknown,success:string,method:'POST'|'DELETE'='POST')=>{
    if(lock.current)return false;
    if(!navigator.onLine){setError(new Error('账户恢复需要联网，请恢复网络后重试。'));return false;}
    const origin=current.current,generation=epoch.current,own=new AbortController();controller.current=own;lock.current=true;setBusy(true);setError(null);setMessage('');
    const active=()=>mounted.current&&current.current===origin&&epoch.current===generation;
    try{
      await accountRequest(path,{method,body,signal:own.signal,networkOnly:true,timeoutMs:30_000,headers:{'X-Account-Settings':'1'}});
      if(active()&&!own.signal.aborted){setMessage(success);return true;}
      return false;
    }catch(failure){if(active()){
      const unknown=own.signal.aborted||(failure instanceof ApiError&&failure.status===0);
      setError(unknown?new Error('请求结果尚未确认。邮件可能已发送或账户状态已更新；请先检查收件箱或刷新账户状态，稍后再手动申请。',{cause:failure}):failure);
    }return false;}finally{lock.current=false;if(active())setBusy(false);}
  };
  return {busy,error,message,online,setError,run,cancel:()=>controller.current?.abort(new DOMException('已取消等待，服务端结果尚未确认','AbortError'))};
}
