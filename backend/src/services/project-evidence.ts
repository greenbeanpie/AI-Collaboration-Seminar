import type { Env } from '../env';
import { invalidState } from '../core/errors';
import { sourceLifecycleGuard } from './source-lifecycle';
import { projectPlanDocumentSql,assessmentDocumentSql } from './project-reference-guard';

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
/** Preserve distinct captured quotes and metadata even when their public IDs match. */
export function uniqueReadReferences(refs:ProjectReference[]):ProjectReference[] {
  const seen=new Set<string>();
  return refs.filter(ref=>{
    const key=JSON.stringify([ref.id,ref.resourceType,ref.resourceId,ref.versionId,ref.revision,ref.fragmentId,ref.pageNumber,ref.title,ref.quote,ref.usage]);
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
}
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
  if(output.directoryOnly===true)return [];
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
    id:`${base.resourceType}:${base.versionId}:${String(f.fragmentId)}:${String(output.offset??0)}`,
    fragmentId:String(f.fragmentId),pageNumber:f.pageNumber as number|null,quote:String(f.quote)}));
  const text=typeof output.text==='string'?output.text:typeof output.body==='string'?output.body:undefined;
  return text ? [{...base,id:`${base.resourceType}:${base.versionId??base.resourceId}:${String(output.offset??0)}`,quote:text}] : [];
}
export async function validateReadReferences(env: Env, projectId: string, refs: ProjectReference[]) {
  if(!Array.isArray(refs))throw invalidState('引用列表格式无效');
  type Row = Record<string,unknown>;
  const queries = new Map<string,{statement:D1PreparedStatement;checks:Array<(row:Row|undefined)=>void>}>();
  const enqueue = (sql:string,bindings:Array<string|number|null>,check:(row:Row|undefined)=>void) => {
    const key=JSON.stringify([sql,bindings]);
    const existing=queries.get(key);
    if(existing) existing.checks.push(check);
    else queries.set(key,{statement:env.DB.prepare(sql).bind(...bindings),checks:[check]});
  };
  for(const ref of refs) {
    if(!ref||typeof ref.resourceId!=='string'||typeof ref.resourceType!=='string'||(ref.quote!==undefined&&typeof ref.quote!=='string')||(ref.revision!==undefined&&(!Number.isInteger(ref.revision)||ref.revision<1)))throw invalidState('引用格式无效');
    if(ref.resourceType==='source'&&([ref.resourceId,ref.versionId,ref.fragmentId].some(value=>typeof value!=='string'||!value.trim()||value==='undefined')||typeof ref.revision!=='number'))throw invalidState('来源引用版本信息不完整');
    if(ref.resourceType==='material'&&typeof ref.versionId!=='string')throw invalidState('材料引用版本信息不完整');
    if(['proposal','assessment'].includes(ref.resourceType)&&typeof ref.revision!=='number')throw invalidState('方案或评价引用版本信息不完整');
    if(ref.resourceType==='source') {
      enqueue(`SELECT f.content FROM source_fragments f JOIN source_versions v ON v.id=f.source_version_id JOIN sources s ON s.id=v.source_id
        WHERE f.id=?1 AND f.project_id=?2 AND v.id=?3 AND v.project_id=?2 AND s.id=?4 AND s.project_id=?2 AND s.lifecycle_version=?5 AND ${sourceLifecycleGuard('v.id','?5')}`,[ref.fragmentId!,projectId,ref.versionId!,ref.resourceId,ref.revision!],row=>{
        if(!row || (ref.quote&&!(row.content as string).includes(ref.quote))) throw invalidState('已读取来源已变化或引用不符，请重新调查');
      });
    } else if(ref.resourceType==='material') {
      enqueue('SELECT v.markdown,v.revision FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?1 AND v.project_id=?2 AND m.id=?3 AND m.project_id=?2',[ref.versionId!,projectId,ref.resourceId],row=>{
        if(!row || (ref.revision!==undefined&&row.revision!==ref.revision) || (ref.quote&&!(row.markdown as string).includes(ref.quote))) throw invalidState('已读取材料引用不符');
      });
    } else if(ref.resourceType==='submission') {
      enqueue('SELECT body,revision FROM task_submissions WHERE id=?1 AND project_id=?2',[ref.resourceId,projectId],row=>{
        if(!row || row.revision!==ref.revision || (ref.quote&&!(row.body as string).includes(ref.quote))) throw invalidState('已读取提交已变化');
      });
    } else if(ref.resourceType==='proposal'||ref.resourceType==='assessment') {
      const table=ref.resourceType==='proposal'?'collaboration_proposals':'assessments';
      const document=ref.resourceType==='proposal'?projectPlanDocumentSql():assessmentDocumentSql();
      enqueue(`SELECT record.revision,${document} body FROM ${table} record WHERE record.id=?1 AND record.project_id=?2`,[ref.resourceId,projectId],row=>{
        if(!row||row.revision!==ref.revision||(ref.quote!==undefined&&!(row.body as string).includes(ref.quote)))throw invalidState('已读取方案或有效评价已变化，引用不符');
      });
    } else {
      const table=({task:'tasks',standard:'standards_versions',requirement:'requirements',rubric:'rubric_versions',decision:'decisions',comment:'comments',event:'events',project:'projects',admin_feedback:'project_admin_feedback'} as Record<string,string>)[ref.resourceType];
      if(!table) throw invalidState('未知引用类型');
      if(ref.resourceType==='project'&&ref.resourceId!==projectId)throw invalidState('项目引用不属于当前项目');
      enqueue(`SELECT * FROM ${table} WHERE id=?1 ${ref.resourceType==='project'?'':'AND project_id=?2'}`,ref.resourceType==='project'?[ref.resourceId]:[ref.resourceId,projectId],row=>{
      if(!row || (ref.revision!==undefined&&row.revision!==ref.revision)) throw invalidState('已读取项目信息已变化');
      if(ref.quote && ref.resourceType!=='project') {
        const captured=JSON.parse(ref.quote) as Record<string,unknown>;
        for(const [key,value] of Object.entries(captured)) if(key in row && JSON.stringify(row[key])!==JSON.stringify(value)) throw invalidState('已读取项目信息已变化');
      }
      });
    }
  }
  // A D1 batch is one Worker subrequest. Repeated reads share the row lookup,
  // while every captured quote/revision is checked, including identical IDs.
  const entries=[...queries.values()];
  for(let offset=0;offset<entries.length;offset+=50) {
    const chunk=entries.slice(offset,offset+50);
    const results=await env.DB.batch<Row>(chunk.map(entry=>entry.statement));
    for(let index=0;index<chunk.length;index++) {
      const row=results[index]?.results[0];
      for(const check of chunk[index]!.checks) check(row);
    }
  }
}
export function decisionReferences(content: string, reads: ProjectReference[]): ProjectReference[] {
  const parsed=referenceEnvelope(content);
  // Validate every decision against the complete read set before marking usage.
  const decisions=extractDecisionReferences(content,reads);
  const ids=new Set(Array.isArray(parsed.referenceIds)?parsed.referenceIds:[]);
  if([...ids].some(id=>typeof id!=='string'||!reads.some(r=>r.id===id))) throw invalidState('决策引用了未读取的参考资料');
  for(const decision of decisions)for(const id of decision.referenceIds)ids.add(id);
  return reads.map(r=>ids.has(r.id)?{...r,usage:'decision'}:r);
}
