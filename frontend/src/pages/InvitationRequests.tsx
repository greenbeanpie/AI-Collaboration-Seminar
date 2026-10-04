import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { projectRequest } from '../api/simplification';
import { ErrorNotice,Field,SectionCard } from '../components/ui';
type Item={id:string;username:string;requestedBy:string;status:'pending'|'approved'|'rejected';revision:number;createdAt:string};
/** canApprove 对应 teamManage：邀请与审批同属团队管理，权限管理仍只属于 owner。 */
export function InvitationRequests({projectId,canApprove}:{projectId:string;canApprove:boolean}){
 const client=useQueryClient(),[username,setUsername]=useState('');
 const refresh=()=>client.invalidateQueries({queryKey:['invitation-requests',projectId]});
 const query=useQuery({queryKey:['invitation-requests',projectId],queryFn:()=>projectRequest<{items:Item[]}>(projectId,'/invitation-requests')});
 const send=useMutation({mutationFn:()=>projectRequest(projectId,'/invitation-requests',{method:'POST',body:{username:username.trim()}}),onSuccess:async()=>{setUsername('');await refresh();}});
 const decide=useMutation({mutationFn:({item,action}:{item:Item;action:'approve'|'reject'})=>projectRequest(projectId,`/invitation-requests/${item.id}/decide`,{method:'POST',body:{expectedRevision:item.revision,action}}),onSuccess:refresh});
 return <SectionCard title={canApprove?'成员邀请申请':'按用户名申请邀请组员'} detail="普通成员提交申请后，由具备团队管理权限的成员批准，再向对方发送邀请。">{!canApprove&&<form className="stack" onSubmit={e=>{e.preventDefault();send.mutate();}}><Field label="完整用户名"><input className="input" required maxLength={64} value={username} onChange={e=>setUsername(e.target.value)}/></Field><button className="button button-primary" disabled={!username.trim()||send.isPending}>报请管理员批准</button></form>}{[query.error,send.error,decide.error].filter(Boolean).map((error,i)=><ErrorNotice key={i} error={error}/>)}{send.isSuccess&&<p role="status">申请已提交，等待管理员批准。</p>}{query.data?.items.map(item=><div className="callout" key={item.id}><strong>{item.username}</strong> · {{pending:'待批准',approved:'已批准并发送邀请',rejected:'已拒绝'}[item.status]}{canApprove&&item.status==='pending'&&<div className="form-actions"><button className="button" disabled={decide.isPending} onClick={()=>decide.mutate({item,action:'approve'})}>批准并发送邀请</button><button className="button button-quiet" disabled={decide.isPending} onClick={()=>decide.mutate({item,action:'reject'})}>拒绝</button></div>}</div>)}</SectionCard>;
}
