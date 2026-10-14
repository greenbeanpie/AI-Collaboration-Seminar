import { useQuery } from '@tanstack/react-query';
import { adminRequest, useSession } from '../auth';
import { ErrorNotice } from './ui';
type Amount={limit:number;used:number;remaining:number};
export type ResourceUsage={ai:{day:string;timezone:'Asia/Shanghai';enabled:boolean;user:Amount;project:Amount|null;platformDailyLimit:number;globalConcurrencyLimit:number};storage:{inventoryReady:boolean;user:Amount&{reserved:number};project:(Amount&{reserved:number})|null}};
const mb=(bytes:number)=>(bytes/1_000_000).toLocaleString('zh-CN',{maximumFractionDigits:1})+' MB';
export function ResourceUsageNotice({projectId}:{projectId?:string}){
  const session=useSession(),accountId=session.data?.id;
  const query=useQuery({queryKey:['resource-usage',accountId,projectId??null],enabled:Boolean(accountId),networkMode:'always',retry:false,staleTime:30_000,queryFn:({signal})=>adminRequest<ResourceUsage>('/api/v1/resource-usage'+(projectId?'?projectId='+encodeURIComponent(projectId):''),{signal})});
  if(!accountId)return null;
  if(query.error)return <ErrorNotice error={query.error} onRetry={()=>void query.refetch()}/>;
  if(!query.data)return <p role="status">正在读取资源额度……</p>;
  const {ai,storage}=query.data;
  return <aside className="notice" aria-label="资源额度"><div className="notice-copy"><strong>{ai.enabled?'今日资源额度':'平台 AI 已暂停'}</strong><p>个人 AI 已用 {ai.user.used}/{ai.user.limit} 次，剩余 {ai.user.remaining} 次。{ai.project&&` 项目已用 ${ai.project.used}/${ai.project.limit} 次，剩余 ${ai.project.remaining} 次。`}</p><p>每天北京时间零点重置（{ai.day}）。每次实际模型请求、重试及语音连接均计一次；继续处理受每日额度限制。平台每日上限 {ai.platformDailyLimit} 次，最多同时执行 {ai.globalConcurrencyLimit} 个请求。</p><p>个人存储已用 {mb(storage.user.used)} / {mb(storage.user.limit)}，上传待确认 {mb(storage.user.reserved)}。{storage.project&&` 项目存储 ${mb(storage.project.used)} / ${mb(storage.project.limit)}。`}{!storage.inventoryReady?' 存储库存尚在核对，暂不允许新上传或付费 AI 请求。':''}</p><button className="button button-quiet button-small" onClick={()=>void query.refetch()} disabled={query.isFetching}>刷新额度</button></div></aside>;
}
