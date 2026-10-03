import { z } from 'zod';
import { newId } from '../core/db';
import { markdownToDoc } from './tiptap';
import type { StandardSnapshot } from './project-simplification';

const key=z.string().trim().min(1).max(64);
// Match the native materials editor's serialized-document storage boundary.
const DOC_MAX_BYTES=200*1024;
const templateMaterial=z.object({key,title:z.string().trim().min(1).max(200),markdown:z.string().max(200_000),purpose:z.enum(['background','reference','output'])}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(markdownToDoc(value.markdown))).byteLength<=DOC_MAX_BYTES,{message:'转换后的资料文档超过200KB限制，请减少内容',path:['markdown']});
const requirement=z.object({key,title:z.string().trim().min(1).max(200),detail:z.string().max(2000).default(''),category:z.enum(['deadline','deliverable','format','scoring','team','other']).default('deliverable'),dueDate:z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/),z.string().datetime({offset:true})]).nullable().optional(),duePrecision:z.enum(['date','datetime','unknown']).optional(),dimensionKey:z.string().min(1).max(40).optional()}).strict().refine(value=>!value.dueDate?.includes('T')||value.duePrecision==='datetime','完整日期时间必须保持 datetime 精度');
const templateStandard=z.object({title:z.string().max(200).default(''),requirements:z.array(requirement).max(100).default([]),weights:z.array(z.object({key:z.string().min(1).max(40),label:z.string().min(1).max(60),weight:z.number().min(0).max(100)}).strict()).max(10).default([]),notes:z.string().max(2000).nullable().optional()}).strict().superRefine((value,ctx)=>{
  if(new Set(value.requirements.map(r=>r.key)).size!==value.requirements.length)ctx.addIssue({code:'custom',message:'要求标识不可重复'});
  if(new Set(value.weights.map(w=>w.key)).size!==value.weights.length)ctx.addIssue({code:'custom',message:'评分维度不可重复'});
  if(value.weights.length&&value.weights.reduce((sum,w)=>sum+w.weight,0)<=0)ctx.addIssue({code:'custom',message:'评分总权重必须大于零'});
  if(value.requirements.some(r=>r.dimensionKey&&!value.weights.some(w=>w.key===r.dimensionKey)))ctx.addIssue({code:'custom',message:'要求关联的评分维度不存在'});
});
export const creationWorkspace=z.object({templateId:z.literal('blank'),materials:z.array(templateMaterial).max(20).default([]),standards:templateStandard.nullable().default(null)}).strict().refine(value=>new Set(value.materials.map(m=>m.key)).size===value.materials.length,'资料标识不可重复');
export type CreationWorkspace=z.infer<typeof creationWorkspace>;
export const projectTemplates=[{templateId:'blank' as const,name:'空项目',description:'从空白工作区编辑项目目标、资料、要求与任务，最终保存后创建项目。'}];
type StatementFactory=(sql:string,...binds:unknown[])=>D1PreparedStatement;

/** Every promotion shares the caller's commit-token guard and D1 transaction. */
export function workspacePromotionStatements(stmt:StatementFactory,guard:string,projectId:string,workspace:CreationWorkspace,now:string):D1PreparedStatement[]{
  const batch:D1PreparedStatement[]=[];
  for(const material of workspace.materials){
    const id=newId(),versionId=newId();
    batch.push(stmt(`INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,revision,created_by,created_at,updated_at) SELECT ?4,?5,?6,?7,?8,?9,1,?2,?10,?10 WHERE ${guard}`,id,projectId,material.title,material.purpose==='background'?'background':'document',material.purpose,versionId,now));
    batch.push(stmt(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) SELECT ?4,?5,?6,1,?7,?8,'manual',?2,?9 WHERE ${guard}`,versionId,id,projectId,JSON.stringify(markdownToDoc(material.markdown)),material.markdown,now));
  }
  const standard=workspace.standards;if(!standard)return batch;
  const setId=newId(),rubricId=newId(),standardId=newId(),requirements=standard.requirements.map(r=>({...r,requirementId:newId()}));
  const snapshot:StandardSnapshot={standardsVersionId:standardId,projectId,version:1,title:standard.title,requirementSetIds:[setId],rubricVersionId:rubricId,mappings:requirements.filter(r=>r.dimensionKey).map(r=>({requirementId:r.requirementId,dimensionKey:r.dimensionKey!})),requirements:requirements.map(r=>({requirementId:r.requirementId,requirementSetId:setId,title:r.title,detail:r.detail,category:r.category,dueDate:r.dueDate??null,duePrecision:r.duePrecision??'unknown',citations:[]})),rubric:{rubricVersionId:rubricId,version:1,weights:standard.weights,notes:standard.notes??null}};
  batch.push(stmt(`INSERT INTO requirement_sets(id,project_id,status,revision,confirmed_by,confirmed_at,created_at,updated_at) SELECT ?4,?5,'confirmed',1,?2,?6,?6,?6 WHERE ${guard}`,setId,projectId,now));
  for(const [i,r] of requirements.entries())batch.push(stmt(`INSERT INTO requirements(id,requirement_set_id,project_id,seq,category,title,detail,due_date,due_precision,citations_json,field_state,updated_at) SELECT ?4,?5,?6,?7,?8,?9,?10,?11,?12,'[]','confirmed',?13 WHERE ${guard}`,r.requirementId,setId,projectId,i+1,r.category,r.title,r.detail,r.dueDate??null,r.duePrecision??'unknown',now));
  batch.push(stmt(`INSERT INTO rubric_versions(id,project_id,version,source,weights_json,notes,status,confirmed_by,confirmed_at,created_at) SELECT ?4,?5,1,'custom',?6,?7,'confirmed',?2,?8,?8 WHERE ${guard}`,rubricId,projectId,JSON.stringify(standard.weights),standard.notes??null,now));
  batch.push(stmt(`INSERT INTO standards_versions(id,project_id,version,title,status,requirement_set_ids_json,rubric_version_id,mappings_json,snapshot_json,revision,confirmed_by,confirmed_at,created_at,updated_at) SELECT ?4,?5,1,?6,'confirmed',?7,?8,?9,?10,1,?2,?11,?11,?11 WHERE ${guard}`,standardId,projectId,standard.title,JSON.stringify([setId]),rubricId,JSON.stringify(snapshot.mappings),JSON.stringify(snapshot),now));
  return batch;
}

/** Preserve the established default-background IDs while making late CAS failures inert. */
export function guardedDescriptionStatements(stmt:StatementFactory,guard:string,projectId:string,description:string,now:string):D1PreparedStatement[]{
  if(!description.trim())return [];
  const nibble=Number.parseInt(projectId[0]!,16),materialId=((nibble+8)%16).toString(16)+projectId.slice(1),versionId=((nibble+4)%16).toString(16)+projectId.slice(1),doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:description}]}]};
  return [stmt(`INSERT INTO materials(id,project_id,title,kind,purpose,is_default_background,current_version_id,revision,created_by,created_at,updated_at) SELECT ?4,?5,'项目背景','background','background',1,?6,1,?2,?7,?7 WHERE ${guard}`,materialId,projectId,versionId,now),stmt(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) SELECT ?4,?5,?6,1,?7,?8,'manual',?2,?9 WHERE ${guard}`,versionId,materialId,projectId,JSON.stringify(doc),description,now)];
}
