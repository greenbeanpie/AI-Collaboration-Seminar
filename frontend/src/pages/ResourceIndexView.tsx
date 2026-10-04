import { useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { projectPath } from '../api/client';
import { documentRequest,importBrowserFile } from './document-import-client';
import { ErrorNotice } from '../components/ui';
type Entry={sectionId:string;heading:string;pageNumber:number|null;excerpt?:string};
type Directory={items:Entry[];nextOffset:number|null;indexStatus:string;coverage:string};
type Section={text?:string;fragments?:Array<{fragmentId:string;pageNumber:number|null;quote:string}>;nextOffset:number|null};
export function ResourceIndexView({projectId,resourceType,versionId,fileId}:{projectId:string;resourceType:'source'|'material';versionId:string;fileId?:string|null}) {
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[offset,setOffset]=useState(0),[section,setSection]=useState<Entry|null>(null),[readOffset,setReadOffset]=useState(0);
 const path=projectPath(projectId,`/resource-index/${resourceType}/${versionId}`);
 const directory=useQuery({queryKey:['resourceIndex',projectId,resourceType,versionId,search,offset],queryFn:()=>documentRequest<Directory>(path+(search?'/search':''),{query:{offset,...(search?{query:search}:{})}}),enabled:open});
 const detail=useQuery({queryKey:['resourceSection',projectId,versionId,section?.sectionId,readOffset],queryFn:()=>documentRequest<Section>(path+'/section',{query:{sectionId:section!.sectionId,neighbors:'true',offset:readOffset}}),enabled:open&&!!section});
 return <details className="card" onToggle={event=>setOpen(event.currentTarget.open)}><summary>材料目录、搜索与原文定位</summary>{open&&<div className="stack">
  <form onSubmit={event=>{event.preventDefault();setSearch(query.trim());setOffset(0);setSection(null);}} className="button-row"><input className="input" aria-label="材料内搜索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索原文关键词"/><button className="button button-quiet" type="submit">搜索</button><button className="button button-quiet" type="button" onClick={()=>{setQuery('');setSearch('');setOffset(0);}}>目录</button></form>
  {directory.error&&<ErrorNotice error={directory.error} onRetry={()=>void directory.refetch()}/>}
  {directory.data&&<p className="form-note">索引：{directory.data.indexStatus} · 正文覆盖：{directory.data.coverage}。搜索摘录不等于完整读取。</p>}
  {directory.data?.indexStatus==='building'&&<button className="button button-quiet" onClick={()=>void directory.refetch()}>继续建立目录</button>}
  <div className="stack">{directory.data?.items.map(item=><button className="button button-quiet" key={item.sectionId} onClick={()=>{setSection(item);setReadOffset(0);}}>{item.pageNumber!==null?`第 ${item.pageNumber} 页 · `:''}{item.heading||'原文段落'}{item.excerpt&&<small>{item.excerpt}</small>}</button>)}</div>
  {offset>0&&<button className="button button-quiet" onClick={()=>setOffset(Math.max(0,offset-20))}>上一批</button>}{directory.data?.nextOffset!=null&&<button className="button button-quiet" onClick={()=>setOffset(directory.data!.nextOffset!)}>下一批</button>}
  {section&&<section><h4>{section.heading||'原文'}</h4>{fileId&&section.pageNumber!==null&&<a href={projectPath(projectId,`/files/${fileId}/content`)+`#page=${section.pageNumber}`} target="_blank" rel="noopener noreferrer">打开原文件对应页</a>}{detail.error&&<ErrorNotice error={detail.error}/>}<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{detail.data?.text??detail.data?.fragments?.map(f=>f.quote).join('\n\n')}</pre>{detail.data?.nextOffset!=null&&<button className="button button-quiet" onClick={()=>setReadOffset(detail.data!.nextOffset!)}>继续读取原文</button>}</section>}
 </div>}</details>;
}
export function BrowserSourceRecovery({projectId,versionId,fileId}:{projectId:string;versionId:string;fileId:string}) {
 const queryClient=useQueryClient();
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState<unknown>(),[controller,setController]=useState<AbortController>();
 async function recover(file?:File) {
  const abort=new AbortController();setController(abort);setBusy(true);setError(undefined);
  try {
   if(!file){const r=await fetch(projectPath(projectId,`/files/${fileId}/content`),{credentials:'include',signal:abort.signal});if(!r.ok)throw new Error('原文件下载失败，请选择同一份原文件重试');const mime=r.headers.get('content-type')??'';file=new File([await r.blob()],mime.includes('wordprocessingml')?'source.docx':'source.pdf',{type:mime});}
   const result=await importBrowserFile(projectId,versionId,file,abort.signal,setNotice);
   setNotice((result.textReady?'本机正文已保存，可以生成总结或提取要求。':result.needsImages?`正文已保存；${result.needsImages} 页仍待识别或确认空白。`:'本机解析未完整完成，保留了已提交正文。')+(result.warnings.length?' '+result.warnings.join('；'):''));await queryClient.invalidateQueries({predicate:q=>['sourceVersion','resourceIndex','resourceSection','sourceFragments','sourceProcessing'].includes(String(q.queryKey[0]))});
  }catch(e){setError(e);}finally{setBusy(false);setController(undefined);}
 }
 return <details className="card"><summary>本机读取原文、云端失败回退</summary><p className="form-note">依赖本机内存与性能，复杂对象可能无法读取；中断时保留已提交正文。客户端提取结果尚未经服务器独立核对。</p><button className="button button-quiet" disabled={busy} onClick={()=>void recover()}>读取服务器保留的原文件</button><label className="field">选择同一份 PDF / DOCX<input type="file" accept=".pdf,.docx" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void recover(f);}}/></label>{busy&&<button className="button button-quiet" onClick={()=>controller?.abort()}>停止本机解析</button>}{notice&&<p role="status">{notice}</p>}{error!=null&&<ErrorNotice error={error}/>}</details>;
}
