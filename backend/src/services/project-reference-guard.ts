import { sourceLifecycleGuard } from './source-lifecycle';

/** Fixed table/column allowlist; reference payloads never supply SQL identifiers. */
const snapshots:Record<string,{table:string;columns:string[];revision?:boolean}>={
 task:{table:'tasks',revision:true,columns:['id','title','detail','criteria','assignee_id','due_date','status','lifecycle_state','revision','effort_hours','current_submission_id']},
 standard:{table:'standards_versions',revision:true,columns:['id','version','revision','title','snapshot_json']},
 requirement:{table:'requirements',columns:['id','requirement_set_id','project_id','seq','category','title','detail','due_date','due_precision','citations_json','field_state','updated_at']},
 rubric:{table:'rubric_versions',columns:['id','version','weights_json','notes']},
 decision:{table:'decisions',columns:['id','title','detail','decided_at','related_json']},
 comment:{table:'comments',columns:['id','target_type','target_id','body','created_at']},
 event:{table:'events',columns:['id','type','entity_type','entity_id','payload_json','occurred_at']},
 admin_feedback:{table:'project_admin_feedback',columns:['id','target_type','target_id','feedback','request_ai_redo','created_at']},
};
export function projectReferenceGuard(referencesSql:string,projectSql:string):string{
 const field=(name:string)=>`json_extract(reference.value,'$.${name}')`;
 const id=field('resourceId'),version=field('versionId'),revision=field('revision'),quote=field('quote'),type=field('resourceType');
 const quoteIncludes=(column:string)=>`(${quote} IS NULL OR instr(${column},${quote})>0)`;
 const source=`(${type}='source' AND EXISTS(SELECT 1 FROM source_fragments fragment JOIN source_versions version ON version.id=fragment.source_version_id JOIN sources source ON source.id=version.source_id WHERE fragment.id=${field('fragmentId')} AND fragment.project_id=${projectSql} AND version.id=${version} AND version.project_id=${projectSql} AND source.id=${id} AND source.project_id=${projectSql} AND source.lifecycle_version=${revision} AND (${field('pageNumber')} IS NULL OR fragment.page_number IS ${field('pageNumber')}) AND ${sourceLifecycleGuard('version.id',revision)} AND ${quoteIncludes('fragment.content')}))`;
 const material=`(${type}='material' AND EXISTS(SELECT 1 FROM material_versions version JOIN materials material ON material.id=version.material_id WHERE version.id=${version} AND version.project_id=${projectSql} AND material.id=${id} AND material.project_id=${projectSql} AND (${revision} IS NULL OR version.revision=${revision}) AND ${quoteIncludes('version.markdown')}))`;
 const submission=`(${type}='submission' AND EXISTS(SELECT 1 FROM task_submissions record WHERE record.id=${id} AND record.project_id=${projectSql} AND record.revision=${revision} AND ${quoteIncludes('record.body')}))`;
 const records=Object.entries(snapshots).map(([resource,spec])=>{
  const rowJson=`json_object(${spec.columns.map(column=>`'${column}',record.${column}`).join(',')})`;
  const fields=`NOT EXISTS(SELECT 1 FROM json_each(${quote}) captured WHERE captured.key IN (${spec.columns.map(column=>`'${column}'`).join(',')}) AND captured.value IS NOT json_extract(${rowJson},'$.'||captured.key))`;
  const taskEdges=resource==='task'?`AND (json_type(${quote},'$.dependencies') IS NULL OR json_extract(${quote},'$.dependencies') IS (SELECT json_group_array(depends_on_task_id) FROM task_dependencies edge WHERE edge.task_id=record.id AND edge.project_id=record.project_id))`:'';
  return `(${type}='${resource}' AND EXISTS(SELECT 1 FROM ${spec.table} record WHERE record.id=${id} AND record.project_id=${projectSql} ${spec.revision?`AND (${revision} IS NULL OR record.revision=${revision})`:''} AND (${quote} IS NULL OR (json_valid(${quote}) AND ${fields} ${taskEdges}))))`;
 });
 const project=`(${type}='project' AND ${id}=${projectSql} AND EXISTS(SELECT 1 FROM projects record WHERE record.id=${projectSql} AND (${revision} IS NULL OR record.revision=${revision}) AND (${quote} IS NULL OR (json_valid(${quote}) AND (json_type(${quote},'$.project.revision') IS NULL OR record.revision=json_extract(${quote},'$.project.revision')) AND (json_type(${quote},'$.goal.revision') IS NULL OR EXISTS(SELECT 1 FROM project_goals goal WHERE goal.project_id=${projectSql} AND goal.revision=json_extract(${quote},'$.goal.revision') AND goal.graph_revision=json_extract(${quote},'$.goal.graph_revision')))))))`;
 return `(${referencesSql} IS NULL OR (json_type(${referencesSql})='array' AND NOT EXISTS(SELECT 1 FROM json_each(${referencesSql}) reference WHERE NOT (${`CASE ${type} ${[['source',source],['material',material],['submission',submission],['project',project],...Object.keys(snapshots).map((key,index)=>[key,records[index]!])].map(([key,expression])=>`WHEN '${key}' THEN ${expression}`).join(' ')} ELSE 0 END`}))))`;
}
