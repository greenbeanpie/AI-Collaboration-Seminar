import { loadAiConfig } from '../ai/config';
import { z } from '@hono/zod-openapi';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { AppError, invalidState, notFound, versionConflict } from '../core/errors';
import { nextCursor, parsePaging } from '../core/pagination';
import { projectPermissionSql, requireProjectPermission } from './project-permissions';
import { effectiveStandardGuardSql } from './effective-standard';
import { sourceInputsGuard } from './source-inputs';
import { scoringReportSchema, scoreAssessment, type AssessmentInput, type AssessmentRow, type ScoringReport } from './assessments';
import { calculateRubricWeightedTotal } from './collaboration-ai';
import { withReservedAiJob, settleReservation } from './ai-reservations';
import { createJobAndDispatch, getJob, failJob, succeedJob } from './jobs';
import { isExecutionPaused } from './ai-execution-control';
import { isBackgroundContinuation } from './ai-execution-slices';

export const followupInput=z.object({expectedRevision:z.number().int().positive(),message:z.string().trim().min(1).max(8000)}).strict();
export const followupSchema=z.object({followupId:z.string().uuid(),assessmentId:z.string().uuid(),userId:z.string().uuid(),message:z.string(),baseRevision:z.number().int(),status:z.enum(['queued','running','succeeded','failed','conflict','cancelled','waiting_input']),jobId:z.string().uuid(),baseReport:scoringReportSchema,proposedReport:scoringReportSchema.nullable(),publishedReport:scoringReportSchema.nullable(),publishedRevision:z.number().int().nullable(),error:z.string().nullable(),createdAt:z.string(),updatedAt:z.string()});
type FollowupRow={id:string;assessment_id:string;project_id:string;user_id:string;message:string;base_revision:number;base_report_json:string;job_id:string;status:string;proposed_report_json:string|null;published_report_json:string|null;published_revision:number|null;error_json:string|null;created_at:string;updated_at:string};
async function assessment(env:Env,projectId:string,id:string){
  const row=await env.DB.prepare('SELECT * FROM assessments WHERE id=?1 AND project_id=?2').bind(id,projectId).first<AssessmentRow>();
  if(!row)throw notFound('评分记录不存在');
  if(row.kind!=='material_review'||row.status!=='succeeded'||!row.report_json)throw invalidState('仅已完成的新材料检查可以追加对话');
  return row;
}
export async function listAssessmentFollowups(env:Env,projectId:string,id:string,query:{cursor?:string;limit?:string}){
  const paging=parsePaging(query),rows=await env.DB.prepare(`SELECT f.*,j.status job_status,j.error_json job_error FROM assessment_followups f LEFT JOIN jobs j ON j.id=f.job_id WHERE f.project_id=?1 AND f.assessment_id=?2 AND (?3 IS NULL OR f.created_at<?3 OR (f.created_at=?3 AND f.id<?4)) ORDER BY f.created_at DESC,f.id DESC LIMIT ?5`).bind(projectId,id,paging.cursor?.createdAt??null,paging.cursor?.id??null,paging.limit+1).all<FollowupRow&{job_status:string|null;job_error:string|null}>();
  const page=rows.results.slice(0,paging.limit),last=page.at(-1);
  return {items:page.map(r=>({followupId:r.id,assessmentId:r.assessment_id,userId:r.user_id,message:r.message,baseRevision:r.base_revision,status:['succeeded','conflict'].includes(r.status)?r.status:r.job_status??r.status,jobId:r.job_id,baseReport:JSON.parse(r.base_report_json) as ScoringReport,proposedReport:r.proposed_report_json?JSON.parse(r.proposed_report_json) as ScoringReport:null,publishedReport:r.published_report_json?JSON.parse(r.published_report_json) as ScoringReport:null,publishedRevision:r.published_revision,error:r.job_error?String(JSON.parse(r.job_error).message??'处理失败'):r.error_json?String(JSON.parse(r.error_json).message):null,createdAt:r.created_at,updatedAt:r.updated_at})),nextCursor:nextCursor(rows.results.length>paging.limit,last?{createdAt:last.created_at,id:last.id}:undefined)??null};
}
export async function createAssessmentFollowup(env:Env,projectId:string,id:string,actorId:string,raw:unknown){
  await requireProjectPermission(env,projectId,actorId,'scoreCorrect');
  const body=followupInput.parse(raw),row=await assessment(env,projectId,id);
  if(!await env.DB.prepare("SELECT 1 FROM projects WHERE id=?1 AND status='active' AND ai_collaboration_enabled=1").bind(projectId).first())throw invalidState('项目 AI 未启用或已归档');
  if((row.revision??1)!==body.expectedRevision)throw versionConflict(row.revision??1);
  if(!(await loadAiConfig(env.DB))?.enabled)throw invalidState('后台 AI 配置未启用');
  return withReservedAiJob(env,{projectId,purpose:'review_run',maxCalls:24},async(jobId,configVersionId)=>{
    const followupId=newId(),now=nowIso();
    const inserted=await env.DB.prepare(`INSERT INTO assessment_followups(id,assessment_id,project_id,user_id,message,base_revision,base_report_json,job_id,created_at,updated_at)
      SELECT ?1,id,project_id,?4,?5,revision,report_json,?6,?7,?7 FROM assessments a WHERE a.id=?2 AND a.project_id=?3 AND revision=?8 AND status='succeeded' AND kind='material_review' AND ${projectPermissionSql('?3','?4','scoreCorrect')} AND ${effectiveStandardGuardSql('?3','a.standards_version_id')}
      AND NOT EXISTS(SELECT 1 FROM assessment_followups f WHERE f.assessment_id=a.id AND ((f.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=f.job_id)) OR EXISTS(SELECT 1 FROM jobs j WHERE j.id=f.job_id AND j.status IN ('queued','running','waiting_input'))))`).bind(followupId,id,projectId,actorId,body.message,jobId,now,body.expectedRevision).run();
    if(!inserted.meta.changes)throw invalidState('评分、权限已变化，或已有追加对话正在处理，请刷新');
    try{await createJobAndDispatch(env,{jobId,projectId,kind:'review_run',input:{assessmentId:id,followupId,projectId,configVersionId},createdBy:actorId});}
    catch(error){if(!await env.DB.prepare('SELECT 1 FROM jobs WHERE id=?1').bind(jobId).first())await env.DB.prepare("UPDATE assessment_followups SET status='failed',error_json=?2,updated_at=?3 WHERE id=?1").bind(followupId,JSON.stringify({message:'作业创建失败，请重新提交'}),nowIso()).run();throw error;}
    return {followupId,jobId};
  });
}
export function mergeFollowupScores(input:AssessmentInput,previous:ScoringReport,proposal:ScoringReport):ScoringReport{
  const scores=proposal.scores.map(score=>previous.scores.find(old=>old.key===score.key&&old.origin==='human')??{...score,origin:'ai' as const}),scored=scores.length>0&&scores.every(s=>s.score!==null);
  const protectedScores=previous.scores.filter(s=>s.origin==='human'),protectedNote=protectedScores.length?'人工修正分数保持原样：'+protectedScores.map(s=>`${s.label} ${s.score===null?'未评分':s.score+'分'}`).join('；')+'。AI 对这些维度的复评仅作为建议。':'';
  return {...proposal,summary:proposal.summary+(protectedNote?'\n\n'+protectedNote:''),limitations:[...new Set([...proposal.limitations,...(protectedNote?[protectedNote]:[])])],scores,status:scored?'scored':'unscorable',weightedTotal:scored?calculateRubricWeightedTotal(input.standard.rubric.weights,scores.map(s=>({key:s.key,score:s.score!}))):null};
}
export async function runAssessmentFollowupJob(env:Env,jobId:string){
  const job=await getJob(env,jobId),input=JSON.parse(job.input_json) as {projectId:string;assessmentId:string;followupId:string;configVersionId?:string};
  let followup:FollowupRow|null=null;
  try{
    followup=await env.DB.prepare('SELECT * FROM assessment_followups WHERE id=?1 AND project_id=?2 AND assessment_id=?3 AND job_id=?4').bind(input.followupId,input.projectId,input.assessmentId,jobId).first<FollowupRow>();
    if(!followup)throw notFound('追加对话作业已失效');
    if(['succeeded','conflict'].includes(followup.status)){await succeedJob(env,jobId,{assessmentId:input.assessmentId,followupId:followup.id});return;}
    const row=await assessment(env,input.projectId,input.assessmentId);
    const assertActive=async()=>{
      await requireProjectPermission(env,input.projectId,followup!.user_id,'scoreCorrect');
      const config=await loadAiConfig(env.DB);if(!config?.enabled||(input.configVersionId&&config.id!==input.configVersionId))throw invalidState('后台模型配置已变化，请重新提交追加对话');
      if(!await env.DB.prepare(`SELECT 1 FROM assessment_followups f JOIN jobs j ON j.id=f.job_id JOIN projects p ON p.id=f.project_id WHERE f.id=?1 AND f.job_id=?2 AND j.status IN ('queued','running') AND p.status='active' AND p.ai_collaboration_enabled=1`).bind(followup!.id,jobId).first())throw invalidState('项目 AI 或追加对话作业已停止');
      for(const versionId of (JSON.parse(row.inputs_json) as AssessmentInput).materialVersionIds)if(!await env.DB.prepare('SELECT 1 FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?1 AND m.project_id=?2 AND m.archived_at IS NULL').bind(versionId,row.project_id).first())throw invalidState('固定成果已归档或不可用');
    };
    await assertActive();
    await env.DB.prepare("UPDATE assessment_followups SET status='running',updated_at=?3 WHERE id=?1 AND job_id=?2").bind(followup.id,jobId,nowIso()).run();
    const prior=await env.DB.prepare('SELECT message,published_report_json FROM assessment_followups WHERE assessment_id=?1 AND project_id=?2 AND created_at<=?3 ORDER BY created_at,id').bind(row.id,row.project_id,followup.created_at).all<{message:string;published_report_json:string|null}>();
    const proposal=followup.proposed_report_json?JSON.parse(followup.proposed_report_json) as ScoringReport:await scoreAssessment(env,{...row,created_by:followup.user_id},jobId,input.configVersionId,[],{currentReport:JSON.parse(followup.base_report_json),conversation:prior.results.map(r=>({message:r.message,summary:r.published_report_json?String(JSON.parse(r.published_report_json).summary):null})),assertActive});
    await env.DB.prepare('UPDATE assessment_followups SET proposed_report_json=?3,updated_at=?4 WHERE id=?1 AND job_id=?2').bind(followup.id,jobId,JSON.stringify(proposal),nowIso()).run();
    await assertActive();
    const report=mergeFollowupScores(JSON.parse(row.inputs_json),JSON.parse(followup.base_report_json),proposal),now=nowIso(),json=JSON.stringify(report),revision=followup.base_revision+1;
    const writes=await env.DB.batch([
      env.DB.prepare(`UPDATE assessments SET ai_report_json=COALESCE(ai_report_json,CASE WHEN origin='ai' THEN report_json END),report_json=?4,origin=CASE WHEN origin='manual' THEN 'manual' ELSE 'ai_adjusted' END,revision=revision+1 WHERE id=?1 AND project_id=?2 AND revision=?3 AND status='succeeded' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=?2 AND p.status='active' AND p.ai_collaboration_enabled=1) AND EXISTS(SELECT 1 FROM ai_config_versions c WHERE c.enabled=1 AND (?8 IS NULL OR c.id=?8) AND c.version=(SELECT MAX(version) FROM ai_config_versions)) AND ${projectPermissionSql('?2','?5','scoreCorrect')} AND ${effectiveStandardGuardSql('?2','assessments.standards_version_id')} AND ${sourceInputsGuard("json_object('sourceSnapshots',json_extract(assessments.inputs_json,'$.allSourceSnapshots'))",'?2')} AND EXISTS(SELECT 1 FROM assessment_followups f JOIN jobs j ON j.id=f.job_id WHERE f.id=?6 AND f.job_id=?7 AND f.status='running' AND j.status IN ('queued','running')) AND NOT EXISTS(SELECT 1 FROM json_each(assessments.inputs_json,'$.materialVersionIds') ids WHERE NOT EXISTS(SELECT 1 FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=ids.value AND m.project_id=?2 AND m.archived_at IS NULL))`).bind(row.id,row.project_id,followup.base_revision,json,followup.user_id,followup.id,jobId,input.configVersionId??null),
      env.DB.prepare(`INSERT INTO assessment_corrections(id,assessment_id,project_id,actor_id,revision,reason,previous_report_json,report_json,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes()=1`).bind(newId(),row.id,row.project_id,followup.user_id,revision,'AI 追加对话复评：'+followup.message,followup.base_report_json,json,now),
      env.DB.prepare(`UPDATE assessment_followups SET status='succeeded',published_report_json=?3,published_revision=?4,error_json=NULL,updated_at=?5 WHERE id=?1 AND job_id=?2 AND changes()=1`).bind(followup.id,jobId,json,revision,now),
    ]);
    if(!writes[0]?.meta.changes)await env.DB.prepare("UPDATE assessment_followups SET status='conflict',error_json=?3,updated_at=?4 WHERE id=?1 AND job_id=?2 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2 AND status IN ('queued','running'))").bind(followup.id,jobId,JSON.stringify({message:'评分、权限或来源已变化；复评建议已保留，未覆盖当前评分'}),now).run();
    await settleReservation(env,jobId,'settled');
    await succeedJob(env,jobId,{assessmentId:row.id,followupId:followup.id,published:!!writes[0]?.meta.changes});
  }catch(error){
    if(isExecutionPaused(error)||isBackgroundContinuation(error))throw error;
    const latest=await getJob(env,jobId);
    if(latest.status==='cancelled'){await settleReservation(env,jobId,'released');return;}
    const failure={code:error instanceof AppError?error.code:'ASSESSMENT_FAILED',message:error instanceof Error?error.message:String(error),...(error instanceof AppError?{details:error.details}:{})};
    if(followup)await env.DB.prepare("UPDATE assessment_followups SET status='failed',error_json=?3,updated_at=?4 WHERE id=?1 AND job_id=?2 AND status NOT IN ('succeeded','conflict')").bind(followup.id,jobId,JSON.stringify(failure),nowIso()).run();
    await settleReservation(env,jobId,'released');await failJob(env,jobId,failure);
  }
}
