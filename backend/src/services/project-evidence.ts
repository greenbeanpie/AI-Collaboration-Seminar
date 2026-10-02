import type { Env } from '../env';
import { invalidState } from '../core/errors';
import { sourceLifecycleGuard } from './source-lifecycle';

export interface ProjectReference {
  id: string;
  resourceType: string;
  resourceId: string;
  versionId?: string;
  revision?: number;
  fragmentId?: string;
  pageNumber?: number | null;
  title?: string;
  quote?: string;
  /** Read metadata is not a claim that this resource supports a decision. */
  usage: 'read' | 'decision';
}
export interface DecisionReference { decisionPath: string; referenceIds: string[] }
function referenceEnvelope(content:string):{referenceIds?:unknown;decisionReferences?:unknown} {
  const start=content.indexOf('{'),end=content.lastIndexOf('}');
  if(start<0||end<=start)return {};
  try{return JSON.parse(content.slice(start,end+1));}catch{return {};}
}
export function extractDecisionReferences(content:string,reads:ProjectReference[]):DecisionReference[] {
  const parsed=referenceEnvelope(content);
  if(parsed.decisionReferences===undefined)return [];
  if(!Array.isArray(parsed.decisionReferences))throw invalidState('决策依据格式无效');
  return parsed.decisionReferences.map((entry:unknown)=>{
    const e=entry as Partial<DecisionReference>;
    if(!e || typeof e.decisionPath!=='string'||!e.decisionPath.length||e.decisionPath.length>200||!Array.isArray(e.referenceIds)||e.referenceIds.some(id=>typeof id!=='string'||!reads.some(r=>r.id===id)))throw invalidState('决策引用了未读取的参考资料');
    return {decisionPath:e.decisionPath,referenceIds:[...new Set(e.referenceIds)]};
  });
}
export function referencesFromRead(output: Record<string,unknown>): ProjectReference[] {
  if(typeof output.resourceType==='string' && Array.isArray(output.items) && !['source','material'].includes(output.resourceType)) {
    return output.items.flatMap((item:Record<string,unknown>)=> typeof item.id==='string' ? [{id:`${output.resourceType}:${item.id}:${String(item.revision??0)}`,resourceType:String(output.resourceType),resourceId:item.id,
      ...(typeof item.revision==='number'?{revision:item.revision}:{}),title:typeof item.title==='string'?item.title:undefined,quote:JSON.stringify(item),usage:'read' as const}] : []);
  }
  const nested=['standards','requirements','rubrics','events','comments'].flatMap(k=>output[k]&&typeof output[k]==='object'?referencesFromRead(output[k] as Record<string,unknown>):[]);
  if(nested.length) return nested;
  if(typeof output.resourceId!=='string') return [];
  const base={resourceType:String(output.resourceType??'source'),resourceId:output.resourceId,
    ...(typeof output.versionId==='string'?{versionId:output.versionId}:{}),
    ...(typeof output.revision==='number'?{revision:output.revision}:{}),
    ...(typeof output.title==='string'?{title:output.title}:{}),usage:'read' as const};
  if(Array.isArray(output.fragments)) return output.fragments.map((f: Record<string,unknown>)=>({...base,
    id:`${base.versionId}:${String(f.fragmentId)}:${String(output.offset??0)}`,
    fragmentId:String(f.fragmentId),pageNumber:f.pageNumber as number|null,quote:String(f.quote)}));
  const text=typeof output.text==='string'?output.text:typeof output.body==='string'?output.body:undefined;
  return text ? [{...base,id:`${base.resourceType}:${base.versionId??base.resourceId}:${String(output.offset??0)}`,quote:text}] : [];
}
export async function validateReadReferences(env: Env, projectId: string, refs: ProjectReference[]) {
  for(const ref of refs) {
    if(ref.resourceType==='source') {
      const row=await env.DB.prepare(`SELECT f.content FROM source_fragments f JOIN source_versions v ON v.id=f.source_version_id JOIN sources s ON s.id=v.source_id
        WHERE f.id=?1 AND f.project_id=?2 AND v.id=?3 AND s.id=?4 AND s.lifecycle_version=?5 AND ${sourceLifecycleGuard('v.id','?5')}`).bind(ref.fragmentId,projectId,ref.versionId,ref.resourceId,ref.revision).first<{content:string}>();
      if(!row || (ref.quote&&!row.content.includes(ref.quote))) throw invalidState('已读取来源已变化或引用不符，请重新调查');
    } else if(ref.resourceType==='material') {
      const row=await env.DB.prepare('SELECT v.markdown FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?1 AND v.project_id=?2 AND m.id=?3').bind(ref.versionId,projectId,ref.resourceId).first<{markdown:string}>();
      if(!row || (ref.quote&&!row.markdown.includes(ref.quote))) throw invalidState('已读取材料引用不符');
    } else if(ref.resourceType==='submission') {
      const row=await env.DB.prepare('SELECT body,revision FROM task_submissions WHERE id=?1 AND project_id=?2').bind(ref.resourceId,projectId).first<{body:string;revision:number}>();
      if(!row || row.revision!==ref.revision || (ref.quote&&!row.body.includes(ref.quote))) throw invalidState('已读取提交已变化');
    } else {
      const table=({task:'tasks',standard:'standards_versions',requirement:'requirements',rubric:'rubric_versions',decision:'decisions',comment:'comments',event:'events',project:'projects',admin_feedback:'project_admin_feedback'} as Record<string,string>)[ref.resourceType];
      if(!table) throw invalidState('未知引用类型');
      const row=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?1 ${ref.resourceType==='project'?'':'AND project_id=?2'}`).bind(...(ref.resourceType==='project'?[ref.resourceId]:[ref.resourceId,projectId])).first<Record<string,unknown>>();
      if(!row || (ref.revision!==undefined&&row.revision!==ref.revision)) throw invalidState('已读取项目信息已变化');
      if(ref.quote && ref.resourceType!=='project') {
        const captured=JSON.parse(ref.quote) as Record<string,unknown>;
        for(const [key,value] of Object.entries(captured)) if(key in row && JSON.stringify(row[key])!==JSON.stringify(value)) throw invalidState('已读取项目信息已变化');
      }
    }
  }
}
export function decisionReferences(content: string, reads: ProjectReference[]): ProjectReference[] {
  const parsed=referenceEnvelope(content);
  if(!Array.isArray(parsed.referenceIds)) return reads;
  const ids=new Set(parsed.referenceIds);
  if([...ids].some(id=>typeof id!=='string'||!reads.some(r=>r.id===id))) throw invalidState('决策引用了未读取的参考资料');
  return reads.map(r=>ids.has(r.id)?{...r,usage:'decision'}:r);
}
