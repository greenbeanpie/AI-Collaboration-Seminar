import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiUrl, projectPath } from '../../api/client';
import { documentRequest } from '../../pages/document-import-client';
import { projectRequest } from '../../api/simplification';
import type { RecordingSession, RecordingSessionDetail } from '../../../../shared/recordings';
const statuses:Record<string,string>={pending:'待处理',running:'处理中',ready:'已完成',partial:'部分完成',unconfigured:'未配置识别模型，原文件已保存',failed:'处理失败',uploading:'上传未完成',complete:'原文件已保存',archived:'已归档',unavailable:'原文件不可用',cancelled:'已停止'};
export function RecordingDetail({projectId,materialId}:{projectId:string;materialId:string}) {
 const [error,setError]=useState('');
 const query=useInfiniteQuery({queryKey:['recordingMaterial',projectId,materialId],initialPageParam:undefined as string|undefined,
 queryFn:async({pageParam,signal})=>{const options={signal,networkOnly:navigator.onLine!==false,offlineReadFallback:true};const rows=await projectRequest<{items:RecordingSession[]}>(projectId,'/recording-sessions',{...options,query:{materialId,limit:1}});if(!rows.items[0])return null;return projectRequest<RecordingSessionDetail>(projectId,`/recording-sessions/${rows.items[0].sessionId}`,{...options,query:{cursor:pageParam,limit:50}});},
 getNextPageParam:last=>last?.nextCursor??undefined,
 refetchInterval:q=>document.hidden||navigator.onLine===false?false:q.state.data?.pages[0]&&['pending','running'].includes(q.state.data.pages[0].processingStatus)?5000:false});
 const session=query.data?.pages[0];if(!session)return query.error?<p role="alert">录制会话读取失败：{String(query.error)}</p>:null;
 const segments=query.data?.pages.flatMap(page=>page?.segments??[])??[];
 return <section aria-label="会议录制片段" className="stack"><h3>会议片段与摘要</h3><p>{statuses[session.status]} · {statuses[session.processingStatus]??session.processingStatus} · 摘要版本 {session.summaryRevision}</p>
 {session.summaryMarkdown&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{session.summaryMarkdown}</pre>}
 {session.interruptions.length>0&&<details><summary>录制中断与暂停：{session.interruptions.length} 处</summary><ul>{session.interruptions.map((i,n)=><li key={n}>{(i.startMs/1000).toFixed(1)}–{(i.endMs/1000).toFixed(1)} 秒：{i.reason}</li>)}</ul></details>}
 {segments.map(s=>{const src=apiUrl(projectPath(projectId,`/files/${s.fileId}/content`));const href=`/app/projects/${projectId}/data?resourceType=source&resourceId=${s.sourceId}&sourceVersionId=${s.sourceVersionId}`;const unavailable=['unavailable','archived'].includes(s.status);return <article key={s.sequence} className="stack"><p>第 {s.sequence} 段 · {(s.startMs/1000).toFixed(1)}–{(s.endMs/1000).toFixed(1)} 秒 · {statuses[s.status]??s.status}{s.error?` · ${s.error}`:''}</p><a href={href}>查看本段来源与处理结果</a>{!unavailable&&(session.kind==='audio'?<audio controls preload="none" src={src}/>:session.kind==='photo'?<img src={src} alt={`第 ${s.sequence} 张采集照片`} loading="lazy" style={{maxWidth:'100%'}}/>:<video controls preload="none" playsInline src={src} style={{maxWidth:'100%',maxHeight:360}}/>)}</article>;})}
 {query.hasNextPage&&<button type="button" className="button button-quiet" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>加载更多片段</button>}{query.error&&<p role="alert">片段读取失败：{String(query.error)}</p>}
 <button type="button" className="button button-quiet" onClick={()=>{void documentRequest(projectPath(projectId,`/recording-sessions/${session.sessionId}/retry`),{method:'POST',body:{}}).then(()=>query.refetch()).catch(e=>setError(String(e)));}}>重试处理</button>{error&&<p role="alert">{error}</p>}</section>;
}
