import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectRequest } from '../api/simplification';
import { ErrorNotice, Spinner } from '../components/ui';
import { idempotencyKeyForIntent,completeIntent } from './aiWorkflowSupport';

type Message={messageId:string;authorId:string;authorName:string;body:string;createdAt:string};
type Inquiry={inquiryId:string;taskId:string;upstreamTaskId:string;taskTitle:string;upstreamTitle:string;requesterId:string;requesterName:string;recipientId:string;recipientName:string;recipientSource:string;messages:Message[]};
type Candidate={taskId:string;title:string;recipientName:string;recipientSource:string};
type Inbox={items:Inquiry[];candidates:Candidate[]};
const sourceLabel=(source:string)=>source==='substitute'?'当前负责人代答':source==='completion'?'完成时负责人':'验收成果提交者';
async function send(projectId:string,path:string,body:unknown){
 const namespace=`inquiry:${projectId}:${path}`;
 const idempotencyKey=await idempotencyKeyForIntent(namespace,body);
 const result=await projectRequest(projectId,path,{method:'POST',body,idempotencyKey});
 completeIntent(namespace);return result;
}
export function TaskInquiries({projectId,taskId,meId}:{projectId:string;taskId:string;meId?:string}) {
 const client=useQueryClient(),key=['task-inquiries',projectId,taskId,meId];
 const query=useQuery({queryKey:key,queryFn:()=>projectRequest<Inbox>(projectId,`/tasks/${taskId}/inquiries`),refetchInterval:30_000});
 const [upstream,setUpstream]=useState(''),[body,setBody]=useState('');
 const create=useMutation({mutationFn:()=>send(projectId,`/tasks/${taskId}/inquiries`,{upstreamTaskId:upstream,body}),onSuccess:async()=>{setBody('');await client.invalidateQueries({queryKey:key});}});
 return <section className="stack" aria-label="前置任务质询"><h3>前置任务质询</h3><p className="form-note">讨论仅发起人与被询问者可见。可针对已完成的直接或间接前置任务询问，双方会收到新消息通知。</p>
 {query.isPending&&<Spinner/>}{query.error&&<ErrorNotice error={query.error}/>}
 {!!query.data?.candidates?.length&&<form className="stack" onSubmit={e=>{e.preventDefault();create.mutate();}}><label>询问哪项前置任务<select className="input" required value={upstream} onChange={e=>setUpstream(e.target.value)}><option value="">请选择前置任务</option>{query.data.candidates.map(t=><option key={t.taskId} value={t.taskId}>{t.title} · {t.recipientName}（{sourceLabel(t.recipientSource)}）</option>)}</select></label><label>对当前任务的影响与问题<textarea className="input" required maxLength={4000} value={body} onChange={e=>setBody(e.target.value)}/></label><button className="button" disabled={!upstream||!body.trim()||create.isPending}>发起质询</button>{create.error&&<ErrorNotice error={create.error}/>}</form>}
 {query.data&&!query.data.items.length&&<p className="form-note">暂无与你有关的质询。</p>}
 {query.data?.items.map(thread=><InquiryThread key={thread.inquiryId} projectId={projectId} thread={thread} refresh={()=>client.invalidateQueries({queryKey:key})}/>)}
 </section>;
}
function InquiryThread({projectId,thread,refresh}:{projectId:string;thread:Inquiry;refresh:()=>Promise<void>}) {
 const [body,setBody]=useState('');
 const reply=useMutation({mutationFn:()=>send(projectId,`/task-inquiries/${thread.inquiryId}/messages`,{body}),onSuccess:async()=>{setBody('');await refresh();}});
 return <article className="callout stack"><strong>{thread.taskTitle} → {thread.upstreamTitle}</strong><small>{thread.requesterName} 询问 {thread.recipientName} · {sourceLabel(thread.recipientSource)}</small>{thread.messages.map(m=><div key={m.messageId}><small>{m.authorName} · {new Date(m.createdAt).toLocaleString('zh-CN')}</small><p className="collab-preserve">{m.body}</p></div>)}<form className="stack" onSubmit={e=>{e.preventDefault();reply.mutate();}}><label>回复或追问<textarea className="input" required maxLength={4000} value={body} onChange={e=>setBody(e.target.value)}/></label><button className="button" disabled={!body.trim()||reply.isPending}>发送消息</button>{reply.error&&<ErrorNotice error={reply.error}/>}</form></article>;
}
