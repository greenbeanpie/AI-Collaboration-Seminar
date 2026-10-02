import type { Env } from '../env';
import type { ToolExchange } from '../ai/tool-transport';
import type { GatewayCallOutput } from '../ai/gateway';
import type { ProjectReference } from './project-evidence';
import { nowIso } from '../core/db';
import { invalidState } from '../core/errors';
export interface InvestigationCheckpoint {
  step: number; exchanges: ToolExchange[]; references: ProjectReference[];
  trace: Array<{name:string;status:string;fileId?:string}>;
  compacted?: string; pendingDispatch?: boolean; content?: string;
  pendingOutput?: GatewayCallOutput;
}
export async function loadInvestigation(env: Env, id: string): Promise<InvestigationCheckpoint | null> {
  const stored=await env.FILES.get(`ai/investigations/${id}.json`);
  if(!stored) return null;
  const checkpoint=await stored.json<InvestigationCheckpoint>();
  if(checkpoint.pendingDispatch) throw invalidState('上次模型请求已派发但结果未确认；请核对调用后重新发起，避免重复付费');
  return checkpoint;
}
export async function saveInvestigation(env: Env, context:{projectId:string;userId:string;jobId?:string}, id:string, promptVersion:string, checkpoint:InvestigationCheckpoint) {
  const key=`ai/investigations/${id}.json`;
  await env.FILES.put(key,JSON.stringify(checkpoint),{httpMetadata:{contentType:'application/json'}});
  await env.DB.prepare(`INSERT INTO ai_investigations(id,project_id,job_id,requested_by,prompt_version,checkpoint_key,phase,step,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,step=excluded.step,updated_at=excluded.updated_at`)
    .bind(id,context.projectId,context.jobId??null,context.userId,promptVersion,key,checkpoint.content?'complete':'read',checkpoint.step,nowIso()).run();
}
/** Deterministic compaction retains resource locators and exact read excerpts; the model can reread omitted content. */
export function compactExchanges(exchanges:ToolExchange[], maxChars:number): {exchanges:ToolExchange[];summary:string} {
  const kept:ToolExchange[]=[];let size=0;
  for(let i=exchanges.length-1;i>=0;i--) {const n=JSON.stringify(exchanges[i]).length;if(size+n>maxChars)break;kept.unshift(exchanges[i]!);size+=n;}
  const removed=exchanges.slice(0,exchanges.length-kept.length);
  const summary=removed.flatMap(e=>e.results.map(r=>({tool:r.call.name,args:r.call.args,
    result: typeof r.output==='object'&&r.output ? Object.fromEntries(Object.entries(r.output).filter(([k])=>!['text','fragments','body'].includes(k)).map(([k,v])=>[k,k==='items'&&Array.isArray(v)?v.map(item=>({id:item.id,resourceId:item.resourceId,versionId:item.versionId,title:item.title})):v])) : r.output}))) ;
  return {exchanges:kept,summary:JSON.stringify(summary)};
}
