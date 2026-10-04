import { RemovedSourceNotice } from './RemovedSourceNotice';
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { projectRequest } from '../api/simplification';
import { collaborationApi, type CollaborationProposal } from '../api/collaboration';
import { idempotencyKeyForIntent, completeIntent } from './aiWorkflowSupport';
import { ErrorNotice, Field } from '../components/ui';
export type CorrectionProposal = Omit<CollaborationProposal, 'status'> & { status: CollaborationProposal['status'] | 'rejected' };
type Row = Record<string, unknown>;
const editableStatuses = ['pending', 'stale', 'rejected'];
const statusLabel = (status: string) => ({pending:'待确认',stale:'已过期',rejected:'已拒绝',applied:'已应用'}[status] ?? status);
export function ProposalCorrection({projectId,proposal,members,onChanged,canApprove=true}:{projectId:string;proposal:CorrectionProposal;members:{userId:string;displayName:string}[];onChanged:()=>Promise<void>;canApprove?:boolean}) {
 const [payload,setPayload]=useState<Record<string,unknown>>(proposal.payload);
 const [savedPayload,setSavedPayload]=useState(JSON.stringify(proposal.payload));
 const [base,setBase]=useState({revision:proposal.revision,status:String(proposal.status)});
 const [fetched,setFetched]=useState<CorrectionProposal|null>(null);
 const [conflict,setConflict]=useState(false);
 const [reason,setReason]=useState('');const [excluded,setExcluded]=useState<string[]>([]);
 const requestLock=useRef(false);
 const latest=fetched && fetched.revision>=proposal.revision?fetched:proposal;
 const outdated=conflict || base.revision!==latest.revision || base.status!==latest.status;
 const editable=editableStatuses.includes(String(latest.status));
 const dirty=JSON.stringify(payload)!==savedPayload;
 const rows=(key:string):Row[]=>Array.isArray(payload[key])?payload[key] as Row[]:[];
 const update=(key:string,index:number,field:string,value:unknown)=>setPayload({...payload,[key]:rows(key).map((row,i)=>i===index?{...row,[field]:value}:row)});
 async function write<T>(tail:string,method:'POST'|'PATCH',body:unknown):Promise<T>{const namespace='proposal-correction:'+projectId+':'+proposal.proposalId+':'+tail;const key=await idempotencyKeyForIntent(namespace,body);const result=await projectRequest<T>(projectId,tail,{method,body,idempotencyKey:key});completeIntent(namespace);return result;}
 const refresh=useMutation({mutationFn:async()=>{const result=(await collaborationApi.proposals(projectId)).items.find(item=>item.proposalId===proposal.proposalId);if(!result)throw new Error('该方案已不可访问；本地修改仍保留。');return result;},onSuccess:result=>setFetched(result)});
 const onError=async(error:unknown)=>{if(error instanceof ApiError && error.status===409)setConflict(true);await onChanged();};
 const revise=useMutation({mutationFn:()=>{if(outdated)throw new Error('请读取并核对最新方案后确认继续，当前修改不会丢失。');return write<CorrectionProposal>('/collaboration/proposals/'+encodeURIComponent(proposal.proposalId),'PATCH',{expectedRevision:base.revision,payload,reason:reason.trim()});},onSuccess:async result=>{setBase({revision:result.revision,status:String(result.status)});setFetched(result);setSavedPayload(JSON.stringify(payload));setConflict(false);await onChanged();},onError});
 const apply=useMutation({mutationFn:()=>{if(!canApprove)throw new Error('任务方案须由项目负责人或拥有任务管理权限的成员确认');if(outdated || dirty)throw new Error('请先核对最新版本并保存本地修改，再应用。');return write('/collaboration/proposals/'+encodeURIComponent(proposal.proposalId)+'/apply','POST',{expectedRevision:base.revision,selectedTaskKeys:rows('tasks').filter(row=>!excluded.includes('tasks:'+row.key)).map(row=>row.key),selectedUpdateTaskIds:rows('updates').filter(row=>!excluded.includes('updates:'+row.taskId)).map(row=>row.taskId),selectedAssignmentTaskIds:rows('assignments').filter(row=>!excluded.includes('assignments:'+row.taskId)).map(row=>row.taskId)});},onSuccess:onChanged,onError});
 const feedback=useMutation({mutationFn:()=>write('/collaboration/feedback','POST',{targetType:'proposal',targetId:proposal.proposalId,feedback:reason.trim(),requestAiRedo:true}),onSuccess:onChanged,onError});
 const busy=revise.isPending || apply.isPending || feedback.isPending;
 const runOnce=(action:(done:()=>void)=>void)=>{if(requestLock.current)return;requestLock.current=true;action(()=>{requestLock.current=false;});};
 return <details><summary>修正建议、部分应用或重新反馈</summary><div className="stack">
 <RemovedSourceNotice payload={latest.payload} />
 <p className="form-note">本地修改基于 r{base.revision}（{statusLabel(base.status)}）；当前方案 r{latest.revision}（{statusLabel(String(latest.status))}）。先保存修改，再按最新版本应用。已应用方案请通过任务详情修正。</p>
 {outdated&&<div className="notice notice-warn" role="status">方案已变化，本地任务内容、工时、选择和反馈均保留。请读取最新方案，核对其内容与状态后明确确认继续；系统不会自动覆盖。</div>}
 <button className="button button-quiet" disabled={busy || refresh.isPending} onClick={()=>refresh.mutate()}>读取最新方案（保留本地修改）</button>
 {fetched&&<div className="callout"><strong>已读取方案 r{fetched.revision} · {statusLabel(String(fetched.status))}</strong>{fetched.payload.goal && <p>主目标：{fetched.payload.goal.title} · {fetched.payload.goal.detail}</p>}<ul>{(['tasks','updates','assignments'] as const).flatMap(key=>Array.isArray(fetched.payload[key])?(fetched.payload[key] as Row[]).map((row,index)=><li key={key+index}>{String(row.title??row.taskId??row.key)}{typeof row.effortHours==='number'?' · '+row.effortHours+' 小时':''}{typeof row.detail==='string'?<p>{row.detail}</p>:null}{typeof row.criteria==='string'&&<p>验收标准：{row.criteria}</p>}{'assigneeId' in row&&<p>执行人：{members.find(member=>member.userId===row.assigneeId)?.displayName ?? (row.assigneeId?'项目成员':'暂不分配')}</p>}</li>):[])}</ul>{outdated&&editable&&<button className="button" disabled={busy || fetched.revision!==latest.revision || fetched.status!==latest.status} onClick={()=>{setBase({revision:fetched.revision,status:String(fetched.status)});setConflict(false);revise.reset();apply.reset();}}>已核对最新方案，保留修改并继续</button>}</div>}
 {editable&&(['tasks','updates','assignments'] as const).map(key=>rows(key).map((row,index)=>{const id=key+':'+(row.key??row.taskId);return <fieldset key={id} disabled={busy}><legend><label><input type="checkbox" checked={!excluded.includes(id)} onChange={event=>setExcluded(current=>event.target.checked?current.filter(item=>item!==id):[...current,id])}/>应用此条目</label></legend>{key==='assignments'?<Field label="执行人"><select className="input" value={String(row.assigneeId??'')} onChange={event=>update(key,index,'assigneeId',event.target.value||null)}><option value="">暂不分配</option>{members.map(member=><option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field>:<>{(['title','detail','criteria'] as const).map(field=><Field label={{title:'任务名称',detail:'说明',criteria:'验收标准'}[field]} key={field}><textarea className="input" value={String(row[field]??'')} onChange={event=>update(key,index,field,event.target.value)}/></Field>)}<Field label="预计工时"><input className="input" type="number" min="0.25" max="200" step="0.25" value={Number(row.effortHours??1)} onChange={event=>update(key,index,'effortHours',Number(event.target.value))}/></Field>{key==='tasks'&&<Field label="前置任务标识（逗号分隔）"><input className="input" value={Array.isArray(row.dependsOn)?row.dependsOn.join(','):''} onChange={event=>update(key,index,'dependsOn',event.target.value.split(',').map(item=>item.trim()).filter(Boolean))}/></Field>}</>}</fieldset>;}))}
 <Field label="修正理由或重新反馈"><textarea className="input" disabled={busy} maxLength={4000} value={reason} onChange={event=>setReason(event.target.value)}/></Field>
 <div className="form-actions">{editable&&<><button className="button" disabled={outdated || !reason.trim() || busy} onClick={()=>runOnce(done=>revise.mutate(undefined,{onSettled:done}))}>保存方案修正</button><button className="button" disabled={!canApprove || outdated || dirty || latest.status!=='pending' || busy} onClick={()=>runOnce(done=>apply.mutate(undefined,{onSettled:done}))}>应用选中条目</button></>}<button className="button" disabled={!reason.trim() || busy} onClick={()=>runOnce(done=>feedback.mutate(undefined,{onSettled:done}))}>反馈并要求 AI 重新判断</button></div>
 {[refresh.error,revise.error,apply.error,feedback.error].filter(Boolean).map((error,i)=><ErrorNotice key={i} error={error}/>)}
 {revise.isSuccess&&<p role="status">方案修正已保存，原始 AI 建议和修订记录保留。</p>}
 </div></details>;
}
