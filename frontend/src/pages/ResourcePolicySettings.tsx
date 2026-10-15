import { useEffect, useRef, useState } from 'react';
import { adminRequest } from '../auth';
import { ErrorNotice, Field, SectionCard } from '../components/ui';
import { useSettingsDirty } from './settings-dirty';
type Policy={version:number;aiEnabled:boolean;userDailyCalls:number;projectDailyCalls:number;platformDailyCalls:number;globalConcurrency:number;userStorageBytes:number;projectStorageBytes:number;platformStorageBytes:number;uploadPoolBytes:number};
const fields=[['userDailyCalls','个人每日 AI 调用上限'],['projectDailyCalls','项目每日 AI 调用上限'],['platformDailyCalls','平台每日 AI 调用上限'],['globalConcurrency','平台同时 AI 请求数'],['userStorageBytes','个人存储上限（字节）'],['projectStorageBytes','项目存储上限（字节）'],['platformStorageBytes','平台总存储上限（字节）'],['uploadPoolBytes','用户上传池上限（字节）']] as const;
export function ResourcePolicySettings({access,token}:{access:boolean;token:string}){
  const [saved,setSaved]=useState<Policy|null>(null),[draft,setDraft]=useState<Policy|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[message,setMessage]=useState('');
  const lock=useRef(false),dirty=Boolean(saved&&JSON.stringify(saved)!==JSON.stringify(draft));useSettingsDirty(dirty);
  const context=useRef({access,token});context.current={access,token};
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{let active=true;const reader=new AbortController();setSaved(null);setDraft(null);setError(undefined);setMessage('');setBusy(false);if(access)void adminRequest<Policy>('/api/v1/admin/resource-policy',{token,signal:reader.signal}).then(policy=>{if(active){setSaved(policy);setDraft(policy);}}).catch(reason=>{if(active)setError(reason);});return()=>{active=false;reader.abort();controller.current?.abort();};},[access,token]);
  const run=async()=>{if(lock.current||!access||!draft||!saved)return;const current=context.current;const ownController=new AbortController();controller.current=ownController;lock.current=true;setBusy(true);setError(undefined);setMessage('');const active=()=>!ownController.signal.aborted&&context.current.access===current.access&&context.current.token===current.token;try{const {version,...policy}=draft;void version;const next=await adminRequest<Policy>('/api/v1/admin/resource-policy',{method:'PUT',token,body:{expectedVersion:saved.version,...policy},signal:ownController.signal});if(active()){setSaved(next);setDraft(next);setMessage('资源策略已保存，下次请求立即按新策略检查。');}}catch(reason){if(active())setError(reason);}finally{lock.current=false;if(active())setBusy(false);}};
  return <SectionCard title="平台资源额度" detail="AI 每次真实请求原子扣额，失败及结果未知也计入当日。每日北京时间零点重置；已发出请求保留原计数。存储统一统计上传和系统对象，总上限为十进制 9 GB；仅统计当前应用 R2 桶；上传池最多占总额的 80%。">{access&&draft&&<>
    <label><input type="checkbox" checked={draft.aiEnabled} disabled={busy} onChange={event=>setDraft({...draft,aiEnabled:event.target.checked})}/> 允许平台 AI 请求（关闭后实时语音在下一次校验结束）</label>{fields.map(([key,label])=>
    <Field key={key} label={label}><input className="input" type="number" min={key==='uploadPoolBytes'?0:1} max={key==='uploadPoolBytes'?7200000000:['userStorageBytes','projectStorageBytes','platformStorageBytes'].includes(key)?9000000000:undefined} step={1} disabled={busy} value={draft[key]} onChange={event=>setDraft({...draft,[key]:Number(event.target.value)})}/>
    </Field>)}<button className="button button-primary" disabled={busy||!dirty} onClick={()=>void run()}>保存资源策略</button>
    <p className="muted">资源策略 v{saved?.version}。100 次处理窗口仅控制暂停节奏，不替代每日硬额度。存储账本包括当前桶内对象和未完成写入预占，不扣除其他桶占用。</p>
    </>}{access&&message&&<p role="status">{message}</p>}{access&&error!==undefined&&<ErrorNotice error={error}/>}</SectionCard>;
    
}
