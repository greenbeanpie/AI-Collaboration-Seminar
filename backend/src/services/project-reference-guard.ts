import { effectiveStandardGuardSql } from './effective-standard';
import { sourceLifecycleGuard } from './source-lifecycle';
import { guideTextSql } from './guide-history';

/** Shared canonical read documents. Fixed identifiers only; callers supply trusted SQL expressions. */
export function projectPlanDocumentSql(record='record'):string {
 return `json_object('id',${record}.id,'kind',${record}.kind,'status',${record}.status,'revision',${record}.revision,
 'effectiveProposal',json(${record}.payload_json),'createdAt',${record}.created_at,'updatedAt',${record}.updated_at,
 'revisionHistory',json((SELECT json_group_array(json_object('id',history.id,'revision',history.revision,'status',history.status,
 'proposal',json(history.payload_json),'reason',history.reason,'actorId',history.actor_id,'createdAt',history.created_at))
 FROM (SELECT * FROM collaboration_proposal_revisions WHERE proposal_id=${record}.id AND project_id=${record}.project_id ORDER BY revision,id) history)))`;
}
export function assessmentDocumentSql(record='record'):string {
 return `json_object('id',${record}.id,'kind',${record}.kind,'status',${record}.status,'revision',${record}.revision,'origin',${record}.origin,
 'goalRevision',${record}.goal_revision,'standardsVersionId',${record}.standards_version_id,'fixedInputs',json(${record}.inputs_json),
 'effectiveReport',json(${record}.report_json),'originalAiReport',json(COALESCE(${record}.ai_report_json,CASE WHEN ${record}.origin='ai' THEN ${record}.report_json END)),'createdAt',${record}.created_at,
 'correctionHistory',json((SELECT json_group_array(json_object('id',history.id,'revision',history.revision,'reason',history.reason,
 'previousReport',json(history.previous_report_json),'effectiveReport',json(history.report_json),'actorId',history.actor_id,'createdAt',history.created_at))
 FROM (SELECT * FROM assessment_corrections WHERE assessment_id=${record}.id AND project_id=${record}.project_id ORDER BY revision,id) history)))`;
}

/** Fixed table/column allowlist; reference payloads never supply SQL identifiers. */
const snapshots:Record<string,{table:string;columns:string[];revision?:boolean}>={
 task:{table:'tasks',revision:true,columns:['id','title','detail','criteria','assignee_id','due_date','status','lifecycle_state','revision','effort_hours','current_submission_id']},
 standard:{table:'standards_versions',revision:true,columns:['id','version','revision','title','snapshot_json']},
 requirement:{table:'requirements',columns:['id','requirement_set_id','project_id','seq','category','title','detail','due_date','due_precision','citations_json','field_state','updated_at']},
 rubric:{table:'rubric_versions',columns:['id','version','weights_json','notes']},
 comment:{table:'comments',columns:['id','target_type','target_id','body','created_at']},
 event:{table:'events',columns:['id','type','entity_type','entity_id','payload_json','occurred_at']},
 admin_feedback:{table:'project_admin_feedback',columns:['id','target_type','target_id','feedback','request_ai_redo','created_at']},
};
export function projectReferenceGuard(referencesSql:string,projectSql:string):string{
 const field=(name:string)=>`json_extract(reference.value,'$.${name}')`;
 const id=field('resourceId'),version=field('versionId'),revision=field('revision'),quote=field('quote'),type=field('resourceType');
 const quoteIncludes=(column:string)=>`(${quote} IS NULL OR instr(${column},${quote})>0)`;
 const source=`(${type}='source' AND EXISTS(SELECT 1 FROM source_fragments fragment JOIN source_versions version ON version.id=fragment.source_version_id JOIN sources source ON source.id=version.source_id WHERE fragment.id=${field('fragmentId')} AND fragment.project_id=${projectSql} AND version.id=${version} AND version.project_id=${projectSql} AND source.id=${id} AND source.project_id=${projectSql} AND source.lifecycle_version=${revision} AND (${field('pageNumber')} IS NULL OR fragment.page_number IS ${field('pageNumber')}) AND ${sourceLifecycleGuard('version.id',revision)} AND ${quoteIncludes('fragment.content')}))`;
 const summary=`(${type}='source_summary' AND json_type(reference.value,'$.offset') IS 'integer' AND ${field('offset')}>=0 AND ${quote} IS NOT NULL AND length(${quote})>0 AND EXISTS(SELECT 1 FROM source_processing processing JOIN source_versions version ON version.id=processing.source_version_id JOIN sources source ON source.id=version.source_id WHERE processing.project_id=${projectSql} AND version.project_id=${projectSql} AND source.project_id=${projectSql} AND version.id=${version} AND source.id=${id} AND source.lifecycle_version=${revision} AND processing.summary_status='ready' AND json_type(reference.value,'$.summaryRevision') IS 'integer' AND processing.summary_revision=${field('summaryRevision')} AND processing.summary_json IS NOT NULL AND ${sourceLifecycleGuard('version.id',revision)} AND ${quoteIncludes('processing.summary_json')}))`;
 const material=`(${type}='material' AND EXISTS(SELECT 1 FROM material_versions version JOIN materials material ON material.id=version.material_id WHERE version.id=${version} AND version.project_id=${projectSql} AND material.id=${id} AND material.project_id=${projectSql} AND (${revision} IS NULL OR version.revision=${revision}) AND ${quoteIncludes('version.markdown')}))`;
 const submission=`(${type}='submission' AND EXISTS(SELECT 1 FROM task_submissions record WHERE record.id=${id} AND record.project_id=${projectSql} AND record.revision=${revision} AND ${quoteIncludes('record.body')}))`;
 const guideTurn=`(${type}='guide_turn' AND EXISTS(SELECT 1 FROM agent_turns turn JOIN agent_sessions session ON session.id=turn.session_id WHERE turn.id=${id} AND turn.project_id=${projectSql} AND session.project_id=${projectSql} AND session.id=${version} AND session.capability='guide' AND session.status='active' AND ${quoteIncludes(guideTextSql)}))`;
 const proposal=`(${type}='proposal' AND EXISTS(SELECT 1 FROM collaboration_proposals record WHERE record.id=${id} AND record.project_id=${projectSql} AND record.revision=${revision} AND ${quoteIncludes(projectPlanDocumentSql())}))`;
 const assessment=`(${type}='assessment' AND EXISTS(SELECT 1 FROM assessments record WHERE record.id=${id} AND record.project_id=${projectSql} AND record.revision=${revision} AND ${quoteIncludes(assessmentDocumentSql())}))`;
 const records=Object.entries(snapshots).map(([resource,spec])=>{
  const rowJson=`json_object(${spec.columns.map(column=>`'${column}',record.${column}`).join(',')})`;
  const fields=`NOT EXISTS(SELECT 1 FROM json_each(${quote}) captured WHERE captured.key IN (${spec.columns.map(column=>`'${column}'`).join(',')}) AND captured.value IS NOT json_extract(${rowJson},'$.'||captured.key))`;
  const activeStandard=resource==='standard'?`AND ${effectiveStandardGuardSql('record.project_id','record.id')}`:resource==='rubric'?`AND record.id=(SELECT rubric_version_id FROM standards_versions WHERE project_id=record.project_id ORDER BY version DESC LIMIT 1)`:resource==='requirement'?`AND record.requirement_set_id IN(SELECT value FROM standards_versions active,json_each(active.requirement_set_ids_json) WHERE active.project_id=record.project_id AND active.version=(SELECT MAX(version) FROM standards_versions WHERE project_id=record.project_id))`:'';
  const taskEdges=resource==='task'?`AND (json_type(${quote},'$.dependencies') IS NULL OR json_extract(${quote},'$.dependencies') IS (SELECT json_group_array(depends_on_task_id) FROM task_dependencies edge WHERE edge.task_id=record.id AND edge.project_id=record.project_id))`:'';
  return `(${type}='${resource}' AND EXISTS(SELECT 1 FROM ${spec.table} record WHERE record.id=${id} AND record.project_id=${projectSql} ${spec.revision?`AND (${revision} IS NULL OR record.revision=${revision})`:''} ${activeStandard} AND (${quote} IS NULL OR (json_valid(${quote}) AND ${fields} ${taskEdges}))))`;
 });
 const project=`(${type}='project' AND ${id}=${projectSql} AND EXISTS(SELECT 1 FROM projects record WHERE record.id=${projectSql} AND (${revision} IS NULL OR record.revision=${revision}) AND (${quote} IS NULL OR (json_valid(${quote}) AND (json_type(${quote},'$.project.revision') IS NULL OR record.revision=json_extract(${quote},'$.project.revision')) AND (json_type(${quote},'$.goal.revision') IS NULL OR EXISTS(SELECT 1 FROM project_goals goal WHERE goal.project_id=${projectSql} AND goal.revision=json_extract(${quote},'$.goal.revision') AND goal.graph_revision=json_extract(${quote},'$.goal.graph_revision')))))))`;
 return `(${referencesSql} IS NULL OR (json_type(${referencesSql})='array' AND NOT EXISTS(SELECT 1 FROM json_each(${referencesSql}) reference WHERE NOT (${`CASE ${type} ${[['source',source],['source_summary',summary],['material',material],['submission',submission],['guide_turn',guideTurn],['proposal',proposal],['assessment',assessment],['project',project],...Object.keys(snapshots).map((key,index)=>[key,records[index]!])].map(([key,expression])=>`WHEN '${key}' THEN ${expression}`).join(' ')} ELSE 0 END`}))))`;
}
