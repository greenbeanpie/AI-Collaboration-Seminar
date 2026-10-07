import { checkpointRootId } from './ai-checkpoints';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { AppError } from '../core/errors';
import { loadAiConfig } from '../ai/config';
import { reserveAiSlot, settleReservation } from './ai-reservations';
import { projectPermissionSql } from './project-permissions';
import { effectiveStandardGuardSql } from './effective-standard';
import { sourceLifecycleGuard } from './source-lifecycle';
import { assertSourceInputs } from './source-inputs';
import { assertProjectSourceContext } from './collaboration-context';
import { assertProfileStamp } from './personal-profiles';
import { retryFailedDraftPreview } from './ai-automatic-retries';

const candidates = `j.status='failed' AND NOT EXISTS(SELECT 1 FROM admin_ai_retry_links l WHERE l.parent_job_id=j.id) AND (j.kind IN ('agent_run','assignment_suggest','review_run','rehearsal_turn','requirement_extract','ocr_pages','parse_source') OR json_extract(j.input_json,'$.operation') IN ('source.summary','media.summary') OR EXISTS(SELECT 1 FROM media_processing WHERE job_id=j.id) OR EXISTS(SELECT 1 FROM ai_calls WHERE job_id=j.id))`;
export interface RetryBatch { batchId:string;status:'queued'|'running'|'completed';total:number;pending:number;queued:number;skipped:number;createdAt:string;updatedAt:string;skipReasons:Array<{reason:string;count:number}> }
async function batchView(env:Env,id:string):Promise<RetryBatch> {
 const row=(await env.DB.prepare('SELECT * FROM admin_ai_retry_batches WHERE id=?1').bind(id).first<{id:string;status:RetryBatch['status'];created_at:string;updated_at:string}>())!;
 const counts=await env.DB.prepare("SELECT COUNT(*) total,COALESCE(SUM(status IN ('pending','running')),0) pending,COALESCE(SUM(status='queued'),0) queued,COALESCE(SUM(status='skipped'),0) skipped FROM admin_ai_retry_items WHERE batch_id=?1").bind(id).first<{total:number;pending:number;queued:number;skipped:number}>();
 const reasons=await env.DB.prepare("SELECT reason,COUNT(*) count FROM admin_ai_retry_items WHERE batch_id=?1 AND status='skipped' GROUP BY reason ORDER BY reason").bind(id).all<{reason:string;count:number}>();
 return {batchId:id,status:row.status,...counts!,createdAt:row.created_at,updatedAt:row.updated_at,skipReasons:reasons.results};
}
export async function readAdminAiRetries(env:Env) {
 const failed=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM jobs j WHERE ${candidates})+(SELECT COUNT(*) FROM project_creation_drafts WHERE status='active' AND preview_state='failed') n`).first<{n:number}>();
 const pending=await env.DB.prepare("SELECT COUNT(*) n FROM admin_ai_retry_items WHERE status='pending'").first<{n:number}>();
 const active=await env.DB.prepare("SELECT id FROM admin_ai_retry_batches WHERE status!='completed' LIMIT 1").first<{id:string}>();
 const latest=await env.DB.prepare('SELECT id FROM admin_ai_retry_batches ORDER BY created_at DESC,id DESC LIMIT 1').first<{id:string}>();
 return {failedCount:failed?.n??0,pendingRetryCount:pending?.n??0,activeBatch:active?await batchView(env,active.id):null,latestBatch:latest?await batchView(env,latest.id):null};
}
/** Remove only work not yet claimed by the retry worker. Source jobs and retry history remain intact. */
export async function clearPendingAdminAiRetries(env:Env) {
 const now=nowIso();
 const [deleted,completed]=await env.DB.batch([
  env.DB.prepare("DELETE FROM admin_ai_retry_items WHERE status='pending'").bind(),
  env.DB.prepare("UPDATE admin_ai_retry_batches SET status='completed',updated_at=?1 WHERE status!='completed' AND NOT EXISTS(SELECT 1 FROM admin_ai_retry_items WHERE batch_id=admin_ai_retry_batches.id AND status IN ('pending','running'))").bind(now),
 ]);
 return {deletedItems:deleted?.meta.changes??0,completedBatches:completed?.meta.changes??0};
}
export async function enqueueAdminAiRetries(env:Env,idempotencyKey:string,actorId:string|null) {
 const existing=await env.DB.prepare('SELECT id FROM admin_ai_retry_batches WHERE idempotency_key=?1 OR status!=\'completed\' ORDER BY idempotency_key=?1 DESC LIMIT 1').bind(idempotencyKey).first<{id:string}>();
 if(existing)return {batch:await batchView(env,existing.id),replayed:true};
 const id=newId(),now=nowIso();
 await env.DB.batch([
 env.DB.prepare("INSERT OR IGNORE INTO admin_ai_retry_batches(id,idempotency_key,requested_by,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)").bind(id,idempotencyKey,actorId,now),
 env.DB.prepare(`INSERT OR IGNORE INTO admin_ai_retry_items(id,batch_id,target_type,target_id,failed_at,updated_at) SELECT lower(hex(randomblob(16))),?1,'job',j.id,j.updated_at,?2 FROM jobs j WHERE ${candidates} AND EXISTS(SELECT 1 FROM admin_ai_retry_batches WHERE id=?1)`).bind(id,now),
 env.DB.prepare("INSERT OR IGNORE INTO admin_ai_retry_items(id,batch_id,target_type,target_id,failed_at,updated_at) SELECT lower(hex(randomblob(16))),?1,'draft',id,updated_at,?2 FROM project_creation_drafts WHERE status='active' AND preview_state='failed' AND EXISTS(SELECT 1 FROM admin_ai_retry_batches WHERE id=?1)").bind(id,now),
 env.DB.prepare("UPDATE admin_ai_retry_batches SET status='completed' WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM admin_ai_retry_items WHERE batch_id=?1)").bind(id),
 ]);
 const actual=await env.DB.prepare("SELECT id FROM admin_ai_retry_batches WHERE id=?1 OR idempotency_key=?2 OR status!='completed' ORDER BY id=?1 DESC LIMIT 1").bind(id,idempotencyKey).first<{id:string}>();
 return {batch:await batchView(env,actual!.id),replayed:actual!.id!==id};
}

export type RetryResult={status:'queued'|'skipped';reason?:string;jobId?:string};
/** A replacement keeps the old terminal job immutable, so late completions cannot publish. */
export async function retryFailedAiJob(env:Env,jobId:string,expectedUpdatedAt?:string,autoRetryRootId?:string,options:{actorId?:string;allowUncertainDispatch?:boolean}={}):Promise<RetryResult> {
 const job=await env.DB.prepare('SELECT * FROM jobs WHERE id=?1').bind(jobId).first<{id:string;project_id:string|null;kind:string;status:string;input_json:string;updated_at:string;created_by:string|null}>();
 if(!job||job.status!=='failed'||(expectedUpdatedAt&&job.updated_at!==expectedUpdatedAt))return {status:'skipped',reason:'任务状态已变化'};
 if(await env.DB.prepare('SELECT 1 FROM admin_ai_retry_links WHERE parent_job_id=?1').bind(jobId).first())return {status:'skipped',reason:'已排队重试'};
 const input=JSON.parse(job.input_json) as Record<string,any>,actor=input.requestedBy??job.created_by;
 if(autoRetryRootId&&(input.mediaProvider==='mimo'||await env.DB.prepare("SELECT 1 FROM media_processing WHERE job_id=?1 AND provider='mimo'").bind(jobId).first()))return {status:'skipped',reason:'MiMo 媒体请求仅允许主动重新处理，不自动重放'};
 if(input.operation==='rehearsal.tts')return {status:'skipped',reason:'朗读已改为系统本地 TTS'};
 let effectiveActor=actor;
 if(!effectiveActor&&job.project_id&&input.sourceVersionId&&['parse_source','ocr_pages','requirement_extract'].includes(job.kind)){effectiveActor=(await env.DB.prepare("SELECT s.created_by FROM sources s JOIN source_versions v ON v.source_id=s.id JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.created_by WHERE v.id=?1 AND s.project_id=?2").bind(input.sourceVersionId,job.project_id).first<{created_by:string}>())?.created_by;}
 if(!effectiveActor)return {status:'skipped',reason:'原请求账户缺失'};
 if(options.actorId && options.actorId!==effectiveActor)return {status:'skipped',reason:'仅原请求账户可继续任务'};
 const actorId=effectiveActor;
 const config=await loadAiConfig(env.DB,input.configVersionId);
 if(!config?.enabled)return {status:'skipped',reason:'原模型配置不可用'};
 const guards:string[]=["EXISTS(SELECT 1 FROM auth_accounts WHERE user_id=?4 AND password_hash IS NOT NULL)","old.status='failed'","old.updated_at=?3","NOT EXISTS(SELECT 1 FROM admin_ai_retry_links WHERE parent_job_id=old.id)"];
 const requiredPermission=job.kind==='review_run'?'scoreInitiate':input.operation==='standards.generate'?'owner':input.operation?.startsWith('collaboration.')&& !['collaboration.summary','collaboration.agent-eligibility','collaboration.assistance-plan','collaboration.evaluate'].includes(input.operation)?'taskManage':null;
 if(job.project_id){
 guards.push("EXISTS(SELECT 1 FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=old.project_id AND p.status='active' AND m.user_id=?4)");
 if(requiredPermission==='owner')guards.push("EXISTS(SELECT 1 FROM project_members WHERE project_id=old.project_id AND user_id=?4 AND role='owner')");
 else if(requiredPermission)guards.push(projectPermissionSql('old.project_id','?4',requiredPermission));
 if(input.sourceSnapshots){if(input.operation?.startsWith('collaboration.'))await assertProjectSourceContext(env,job.project_id,input.sourceSnapshots);else await assertSourceInputs(env,job.project_id,input.preferredSourceVersionIds??input.sourceVersionIds??[],input.sourceSnapshots);}
 if(input.profileStamp)await assertProfileStamp(env,job.project_id,input.profileStamp);
 }
 if(input.goalRevision!==undefined||input.goal?.revision!==undefined)guards.push("EXISTS(SELECT 1 FROM project_goals WHERE project_id=old.project_id AND revision=COALESCE(json_extract(old.input_json,'$.goalRevision'),json_extract(old.input_json,'$.goal.revision')))");
 if(input.operation==='standards.generate'||input.operation?.startsWith('collaboration.'))guards.push("EXISTS(SELECT 1 FROM ai_config_versions WHERE id=json_extract(old.input_json,'$.configVersionId') AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions))");
 if(input.sourceVersionId)guards.push(sourceLifecycleGuard("json_extract(old.input_json,'$.sourceVersionId')","COALESCE(json_extract(old.input_json,'$.sourceLifecycleVersion'),1)"));
 if(input.sourceVersionId&&input.operation!=='source.summary'&&input.operation!=='media.summary')guards.push("EXISTS(SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=json_extract(old.input_json,'$.sourceVersionId') AND s.current_version_id=v.id) AND NOT EXISTS(SELECT 1 FROM jobs newer WHERE newer.project_id=old.project_id AND newer.id!=old.id AND json_extract(newer.input_json,'$.sourceVersionId')=json_extract(old.input_json,'$.sourceVersionId') AND newer.kind=old.kind AND COALESCE(json_extract(newer.input_json,'$.operation'),'')=COALESCE(json_extract(old.input_json,'$.operation'),'') AND COALESCE(json_extract(newer.input_json,'$.phase'),'')=COALESCE(json_extract(old.input_json,'$.phase'),'') AND (newer.created_at>old.created_at OR newer.status IN ('queued','running','waiting_input')))");
 if(input.sourceVersionId)guards.push("EXISTS(SELECT 1 FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=json_extract(old.input_json,'$.sourceVersionId') AND s.current_version_id=v.id)");
 if(input.operation==='media.summary')guards.push("NOT EXISTS(SELECT 1 FROM source_processing WHERE source_version_id=json_extract(old.input_json,'$.sourceVersionId') AND summary_job_id IS NOT NULL AND summary_job_id!=old.id)");
 if(input.standardsVersionId)guards.push(effectiveStandardGuardSql('old.project_id',"json_extract(old.input_json,'$.standardsVersionId')"));
 if(input.settingsRevision!==undefined)guards.push("EXISTS(SELECT 1 FROM projects WHERE id=old.project_id AND ai_collaboration_enabled=1 AND collaboration_revision=json_extract(old.input_json,'$.settingsRevision'))");
 if(input.tasks)for(const task of input.tasks){const current=await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1 AND project_id=?2').bind(task.taskId,job.project_id).first<{revision:number}>();if(current?.revision!==task.revision)return {status:'skipped',reason:'任务版本已变化'};}
 const reset:Array<{table:string;pointer:string;extra?:string}>=[];
 const requireRow=async(table:string,pointer:string,condition:string)=>{guards.push(`EXISTS(SELECT 1 FROM ${table} WHERE ${pointer}=old.id AND ${condition})`);};
 if(input.operation==='media.draft')guards.push("EXISTS(SELECT 1 FROM creation_draft_files f JOIN project_creation_drafts d ON d.id=f.draft_id WHERE f.id=json_extract(old.input_json,'$.fileId') AND d.id=json_extract(old.input_json,'$.draftId') AND f.removed=0 AND d.status='active' AND d.owner_id=?4)");
 if(input.operation==='source.summary'){await requireRow('source_processing','summary_job_id',"summary_status='failed'");reset.push({table:'source_processing',pointer:'summary_job_id',extra:"summary_status='queued',summary_error=NULL,"});}
 if(input.runId){await requireRow('agent_runs','job_id',"status='failed'");reset.push({table:'agent_runs',pointer:'job_id',extra:"status='running',output_json=NULL,"});}
 if(input.reviewId){await requireRow('reviews','job_id',"status='failed' AND created_by=?4");reset.push({table:'reviews',pointer:'job_id',extra:"status='pending',"});}
 if(input.rehearsalId){await requireRow('rehearsals','processing_job_id',"status='active' AND created_by=?4");reset.push({table:'rehearsals',pointer:'processing_job_id',extra:"finish_job_id=CASE WHEN finish_job_id=?1 THEN ?2 ELSE finish_job_id END,"});}
 if(input.assessmentId||input.rehearsalId){await requireRow('assessments','job_id',"status!='succeeded' AND origin='ai' AND revision=1");reset.push({table:'assessments',pointer:'job_id',extra:"status='active',"});}
 if(input.submissionId){await requireRow('task_submissions','evaluation_job_id',"status IN ('pending','evaluated') AND EXISTS(SELECT 1 FROM tasks t WHERE t.current_submission_id=task_submissions.id AND t.lifecycle_state='submitted' AND t.revision=task_submissions.task_revision AND t.assignee_id=task_submissions.submitted_by) AND (submitted_by=?4 OR "+projectPermissionSql('task_submissions.project_id','?4','taskManage')+')');reset.push({table:'task_submissions',pointer:'evaluation_job_id'});}
 if(input.operation==='collaboration.decompose'||input.operation==='collaboration.assign'){
 guards.push("NOT EXISTS(SELECT 1 FROM collaboration_proposals WHERE job_id=old.id AND status!='pending')");
 reset.push({table:'collaboration_proposals',pointer:'job_id'});
 }
 const caches:Record<string,string>={'collaboration.summary':'task_summaries','collaboration.agent-eligibility':'task_agent_eligibility','collaboration.assistance-plan':'task_assistance_plans'};
 if(caches[input.operation]){await requireRow(caches[input.operation]!,'job_id',"status='failed'");reset.push({table:caches[input.operation]!,pointer:'job_id',extra:"status='queued',"});}
 if(input.taskId)guards.push("EXISTS(SELECT 1 FROM tasks WHERE id=json_extract(old.input_json,'$.taskId') AND project_id=old.project_id AND (assignee_id=?4 OR "+projectPermissionSql('old.project_id','?4','taskManage')+'))');
 const root=await checkpointRootId(env,jobId);
 const id=newId(),now=nowIso();
 const eligible=await env.DB.prepare(`SELECT 1 FROM jobs old WHERE old.id=?1 AND ${guards.join(' AND ')}`).bind(jobId,id,job.updated_at,actorId).first();
 if(!eligible)return {status:'skipped',reason:'权限、版本或当前业务状态已变化'};
 const reservation=await env.DB.prepare('SELECT purpose,max_calls FROM usage_reservations WHERE job_id=?1 ORDER BY created_at DESC LIMIT 1').bind(jobId).first<{purpose:string;max_calls:number}>();
 if(job.project_id)await reserveAiSlot(env,{projectId:job.project_id,jobId:id,purpose:reservation?.purpose??job.kind,maxCalls:reservation?.max_calls??2,configVersionId:config.id});
 try{
 const inserted=await env.DB.batch([
 env.DB.prepare(`INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) SELECT ?2,project_id,kind,'queued',json_set(CASE WHEN ?6 IS NULL THEN json_remove(input_json,'$.autoRetryRootId') ELSE json_set(input_json,'$.autoRetryRootId',?6) END,'$.checkpointRootId',?7,'$.allowUncertainCheckpointRetry',json(?8)),0,COALESCE(created_by,?4),?5,?5 FROM jobs old WHERE old.id=?1 AND ${guards.join(' AND ')}`).bind(jobId,id,job.updated_at,actorId,now,autoRetryRootId??null,root,options.allowUncertainDispatch===true?'true':'false'),
 env.DB.prepare('INSERT INTO admin_ai_retry_links(parent_job_id,retry_job_id,created_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?2)').bind(jobId,id,now),
  env.DB.prepare("INSERT INTO media_processing(id,job_id,source_version_id,draft_file_id,config_version_id,stage,duration_seconds,windows_json,summary_json,created_at,updated_at,provider) SELECT ?3,?2,source_version_id,draft_file_id,config_version_id,'pending',duration_seconds,windows_json,summary_json,?4,?4,provider FROM media_processing WHERE job_id=?1 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)").bind(jobId,id,newId(),now),
 env.DB.prepare("INSERT INTO audio_pipeline(job_id,phase,transcript_r2_key,quality_json,chunks_json,final_summary_json,summaries_json,config_version_id,fallback_config_version_id,created_at,updated_at) SELECT ?2,CASE WHEN final_summary_json IS NOT NULL THEN 'ready' WHEN json_array_length(chunks_json)=0 THEN 'pending' WHEN json_array_length(quality_json)<json_array_length(chunks_json) THEN 'transcribed' ELSE 'checked' END,transcript_r2_key,quality_json,chunks_json,final_summary_json,summaries_json,config_version_id,fallback_config_version_id,?3,?3 FROM audio_pipeline WHERE job_id=?1 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)").bind(jobId,id,now),
 env.DB.prepare("UPDATE source_versions SET status='pending',parse_error=NULL WHERE id=json_extract((SELECT input_json FROM jobs WHERE id=?2),'$.sourceVersionId') AND status='failed' AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)").bind(jobId,id),
 env.DB.prepare("UPDATE source_pages SET ocr_status='pending',updated_at=?3 WHERE source_version_id=json_extract((SELECT input_json FROM jobs WHERE id=?2),'$.sourceVersionId') AND ocr_status='failed' AND EXISTS(SELECT 1 FROM jobs WHERE id=?2 AND kind='ocr_pages')").bind(jobId,id,now),
 ...reset.map(row=>env.DB.prepare(`UPDATE ${row.table} SET ${row.extra??''}${row.pointer}=?2 WHERE ${row.pointer}=?1 AND EXISTS(SELECT 1 FROM jobs WHERE id=?2)`).bind(jobId,id)),
 env.DB.prepare("INSERT INTO job_outbox(id,job_id,status,available_at,attempts,created_at,updated_at) SELECT ?1,?2,'pending',?3,0,?3,?3 WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?2)").bind(newId(),id,now),
 ]);
 if(!inserted[0]?.meta.changes){if(job.project_id)await settleReservation(env,id,'released');return {status:'skipped',reason:'权限、版本或当前业务状态已变化'};}
 return {status:'queued',jobId:id};
 }catch(error){if(job.project_id)await settleReservation(env,id,'released');throw error;}
}

export async function recoverAdminAiRetries(env:Env,limit=10):Promise<void>{
 const now=nowIso();
 // A crashed handler may have submitted work: never blindly replay the uncertain item.
 await env.DB.prepare("UPDATE admin_ai_retry_items SET status='skipped',reason='排队结果未确认，请核对当前业务状态',updated_at=?1 WHERE status='running' AND updated_at<?2").bind(now,new Date(Date.now()-600000).toISOString()).run();
 const rows=await env.DB.prepare("SELECT * FROM admin_ai_retry_items WHERE status='pending' ORDER BY updated_at,id LIMIT ?1").bind(limit).all<{id:string;batch_id:string;target_type:string;target_id:string;failed_at:string}>();
 for(const row of rows.results){
 const claimed=await env.DB.prepare("UPDATE admin_ai_retry_items SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'").bind(row.id,now).run();if(!claimed.meta.changes)continue;
 await env.DB.prepare("UPDATE admin_ai_retry_batches SET status='running',updated_at=?2 WHERE id=?1").bind(row.batch_id,now).run();
 let result:RetryResult;
 try{if(row.target_type==='job')result=await retryFailedAiJob(env,row.target_id,row.failed_at);else{
 const draftResult=await retryFailedDraftPreview(env,row.target_id,row.failed_at);result={status:draftResult.status==='retried'?'queued':'skipped',jobId:draftResult.jobId,reason:draftResult.reason};
 }}catch(error){
   if(error instanceof AppError && error.code==='QUOTA_EXCEEDED' && error.details?.limit){
     await env.DB.prepare("UPDATE admin_ai_retry_items SET status='pending',reason='等待项目 AI 并发槽位',updated_at=?2 WHERE id=?1 AND status='running'").bind(row.id,nowIso()).run();
     continue;
   }
   result={status:'skipped',reason:error instanceof AppError&&error.code==='QUOTA_EXCEEDED'?'并发或调用次数额度不足':'权限、版本或配置已变化'};
 }
 await env.DB.prepare('UPDATE admin_ai_retry_items SET status=?2,reason=?3,retry_job_id=?4,updated_at=?5 WHERE id=?1 AND status=\'running\'').bind(row.id,result.status,result.reason??null,result.jobId??null,nowIso()).run();
 }
 await env.DB.prepare("UPDATE admin_ai_retry_batches SET status='completed',updated_at=?1 WHERE status!='completed' AND NOT EXISTS(SELECT 1 FROM admin_ai_retry_items WHERE batch_id=admin_ai_retry_batches.id AND status IN ('pending','running'))").bind(nowIso()).run();
}
