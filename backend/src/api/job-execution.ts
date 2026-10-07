import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv, Env } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { requireUser } from '../core/auth';
import { invalidState, permissionDenied } from '../core/errors';
import { nowIso } from '../core/db';
import { authorizedJob, currentSuccessor } from './jobs';
import { withIdempotency } from '../services/idempotency';
import { cancelExecution, executionSchema, pauseExecution, readExecution, resolveExecutionTarget, resumeExecution } from '../services/ai-execution-control';
import { dispatchResumedExecution } from '../services/ai-execution-slices';
import { reserveAiSlot, settleReservation } from '../services/ai-reservations';
import { getJob, succeedJob, type JobRow } from '../services/jobs';
import { loadActiveSourceVersion } from '../services/source-lifecycle';

/** Deliver known covered material without marking the source's OCR/text pipeline complete. */
async function partialMaterial(env:Env,job:JobRow):Promise<unknown|null>{
 const media=await env.DB.prepare('SELECT windows_json,summary_json,duration_seconds FROM media_processing WHERE job_id=?1').bind(job.id).first<{windows_json:string;summary_json:string|null;duration_seconds:number|null}>();
 const audio=await env.DB.prepare('SELECT transcript_r2_key,summaries_json,chunks_json,quality_json FROM audio_pipeline WHERE job_id=?1').bind(job.id).first<{transcript_r2_key:string|null;summaries_json:string;chunks_json:string;quality_json:string}>();
 if(media||audio){
   const windows=JSON.parse(media?.windows_json??'[]') as Array<{summary:string}>;
   const summaries=JSON.parse(audio?.summaries_json??'[]') as Array<{summary:string}>;
   const processed=windows.length?windows:summaries;
   let transcript:unknown=null;
   if(audio?.transcript_r2_key){const object=await env.FILES.get(audio.transcript_r2_key);if(object)transcript=JSON.parse(await object.text());}
   if(!processed.length&&!transcript)return null;
   return {partial:true,complete:false,mediaSummary:processed.length>0,summary:processed.map(s=>s.summary).join('\n\n'),transcript,coverage:{completedWindows:windows.length,completedChunks:summaries.length,totalChunks:(JSON.parse(audio?.chunks_json??'[]') as unknown[]).length,durationSeconds:media?.duration_seconds??null},caveats:['用户主动输出当前结果；尚未完整处理原文件，未处理范围和转录质量不能视为已经验证。']};
 }
 if(job.kind==='ocr_pages'){
   const input=JSON.parse(job.input_json) as {sourceVersionId:string};
   const pages=await env.DB.prepare('SELECT page_number,ocr_status FROM source_pages WHERE source_version_id=?1 ORDER BY page_number').bind(input.sourceVersionId).all<{page_number:number;ocr_status:string}>();
   const fragments=await env.DB.prepare('SELECT id,page_number,content FROM source_fragments WHERE source_version_id=?1 ORDER BY seq').bind(input.sourceVersionId).all<{id:string;page_number:number|null;content:string}>();
   if(!fragments.results.length)return null;
   return {partial:true,complete:false,sourceVersionId:input.sourceVersionId,coverage:{completedPages:pages.results.filter(p=>p.ocr_status==='ok').map(p=>p.page_number),remainingPages:pages.results.filter(p=>p.ocr_status!=='ok').map(p=>p.page_number)},fragments:fragments.results,caveats:['用户主动输出当前 OCR 结果；资料正文尚未完整提取，来源状态保持未完成。']};
 }
 return null;
}

export function registerJobExecutionRoutes(app:OpenAPIHono<AppEnv>):void{
 app.use('/api/v1/jobs/:jobId/execution/*',requireUser);
 app.openapi(createRoute({method:'post',path:'/api/v1/jobs/{jobId}/execution/{action}',tags:['jobs'],summary:'继续、输出当前结果或取消后台 AI 处理',request:{params:z.object({jobId:z.string().uuid(),action:z.enum(['continue','output','cancel'])}),body:{content:{'application/json':{schema:z.object({expectedGeneration:z.number().int().min(1),allowUncertainDispatch:z.boolean().optional()}).strict()}}}},responses:{202:{description:'执行操作已保存',content:{'application/json':{schema:apiEnvelope(z.object({jobId:z.string().uuid(),execution:executionSchema.nullable()}),'JobExecutionResponse')}}},409:{description:'执行代次变化或状态不允许',content:{'application/json':{schema:apiErrorEnvelope}}}}}),async c=>{
  const {jobId:original,action}=c.req.valid('param'),body=c.req.valid('json'),user=c.get('user')!;
  await authorizedJob(c.env,original,user.id);
  const job=await authorizedJob(c.env,await currentSuccessor(c.env,original),user.id);
  const input=JSON.parse(job.input_json) as {requestedBy?:string;sourceVersionId?:string;sourceLifecycleVersion?:number;configVersionId?:string};
  const requestedActor=input.requestedBy??job.created_by;
  if(requestedActor&&requestedActor!==user.id)throw permissionDenied('仅原请求账户可继续、输出或取消任务');
  if(!requestedActor&&job.project_id&&!await c.env.DB.prepare("SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2 AND role='owner'").bind(job.project_id,user.id).first())throw permissionDenied('自动任务仅项目负责人可继续、输出或取消');
  if(input.sourceVersionId)await loadActiveSourceVersion(c.env,input.sourceVersionId,input.sourceLifecycleVersion);
  const target=await resolveExecutionTarget(c.env,{kind:'job',id:job.id});
  const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),required:true,userId:user.id,operation:'ai.execution:'+job.id+':'+action,rawBody:JSON.stringify(body)},async()=>{
    if(['succeeded','cancelled'].includes((await getJob(c.env,job.id)).status))throw invalidState('任务已结束');
    if(action==='cancel'){
      await cancelExecution(c.env,target,body.expectedGeneration);
      // The execution and active retry descendants were cancelled atomically by the controller.
      await settleReservation(c.env,job.id,'settled');
    }else{
      const execution=await readExecution(c.env,target);
      if(!execution)throw invalidState('该任务没有可继续的 AI 检查点');
      await resumeExecution(c.env,target,body.expectedGeneration,action,{allowUncertainDispatch:body.allowUncertainDispatch});
      try{if(job.project_id)await reserveAiSlot(c.env,{projectId:job.project_id,jobId:job.id,purpose:'execution_resume',configVersionId:input.configVersionId});}
      catch(error){await pauseExecution(c.env,target,'interrupted');throw error;}
      if(execution.pauseReason==='request_uncertain'&&body.allowUncertainDispatch)await c.env.DB.prepare("UPDATE jobs SET input_json=json_set(input_json,'$.allowUncertainCheckpointRetry',json('true')) WHERE id=?1 AND status='waiting_input'").bind(job.id).run();
      await c.env.DB.prepare("UPDATE jobs SET status='running',error_json=NULL,finished_at=NULL,updated_at=?2 WHERE id=?1 AND status IN ('waiting_input','failed')").bind(job.id,nowIso()).run();
      const material=action==='output'?await partialMaterial(c.env,job):null;
      if(material){await succeedJob(c.env,job.id,material);await settleReservation(c.env,job.id,'settled');}
      else if(action==='output'&&(job.kind==='ocr_pages'||await c.env.DB.prepare('SELECT 1 FROM media_processing WHERE job_id=?1').bind(job.id).first())){
        await pauseExecution(c.env,target,'output_invalid');await settleReservation(c.env,job.id,'settled');
      }else await dispatchResumedExecution(c.env,job.id);
    }
    return {status:202 as const,body:{jobId:job.id,execution:await readExecution(c.env,target)}};
  });
  return c.json(apiData(c,result.body),202);
 });
}
