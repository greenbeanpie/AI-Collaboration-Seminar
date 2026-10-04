import type { Env } from '../env';
import { loadAiConfig } from '../ai/config';
import { unseal } from '../ai/secrets';
import { GeminiMediaClient, mediaSummarySchema, mediaSummaryText, type MediaSummary } from '../ai/gemini-media';
import { nowIso, newId } from '../core/db';
import { AppError, invalidState } from '../core/errors';
import { createJobAndDispatch, getJob, failJob, succeedJob } from './jobs';
import { loadActiveSourceVersion, assertSourceJobActive, sourceLifecycleGuard } from './source-lifecycle';
import { reserveAiSlot, markAiCallStarted, settleReservation } from './budget';

interface State {id:string;job_id:string;source_version_id:string|null;draft_file_id:string|null;config_version_id:string;stage:string;provider_name:string|null;provider_uri:string|null;windows_json:string;summary_json:string|null;}
export async function enqueueDraftMedia(env:Env,draftId:string,fileId:string,userId:string):Promise<void> {
  const config=await loadAiConfig(env.DB);
  if(!config?.enabled || !config.config.mediaUnderstanding?.apiKeyEncrypted) {
    await env.DB.prepare("UPDATE creation_draft_files SET text_error='音视频模型尚未配置；原文件已保留，可创建后处理' WHERE id=?1 AND draft_id=?2").bind(fileId,draftId).run();return;
  }
  await createJobAndDispatch(env,{projectId:null,kind:'agent_run',createdBy:userId,input:{operation:'media.draft',draftId,fileId,configVersionId:config.id}});
}
export async function runMediaJob(env:Env,jobId:string,sourceVersionId?:string):Promise<{status:string}> {
  const job=await getJob(env,jobId),input=JSON.parse(job.input_json) as {draftId?:string;fileId?:string;configVersionId?:string;sourceLifecycleVersion?:number};
  if(['succeeded','failed','cancelled'].includes(job.status))return {status:job.status};
  const assertActive=async()=>{
    const current=await getJob(env,jobId);if(!['queued','running'].includes(current.status))throw invalidState('媒体任务已停止');
    if(sourceVersionId){await loadActiveSourceVersion(env,sourceVersionId,input.sourceLifecycleVersion);await assertSourceJobActive(env,jobId);}
    else if(!await env.DB.prepare("SELECT 1 FROM creation_draft_files f JOIN project_creation_drafts d ON d.id=f.draft_id WHERE f.id=?1 AND d.id=?2 AND f.removed=0 AND d.status='active'").bind(input.fileId!,input.draftId!).first())throw invalidState('草稿或文件已删除、取消或提交');
  };
  let client:GeminiMediaClient|undefined,state:State|null=null;
  try {
    await assertActive();
    const config=await loadAiConfig(env.DB,input.configVersionId),model=config?.config.mediaUnderstanding;
    if(!config?.enabled || !model?.apiKeyEncrypted)throw new AppError('AI_UNAVAILABLE','音视频 Gemini 模型尚未配置；原文件已保留',503,false);
    client=new GeminiMediaClient(model,await unseal(model.apiKeyEncrypted,env.AUTH_SECRET));
    const file=sourceVersionId?await env.DB.prepare('SELECT f.r2_key,f.mime_detected AS mime,f.size_bytes,f.original_name AS name FROM source_versions v JOIN files f ON f.id=v.file_id WHERE v.id=?1').bind(sourceVersionId).first<{r2_key:string;mime:string;size_bytes:number;name:string}>():await env.DB.prepare('SELECT r2_key,mime,size_bytes,name FROM creation_draft_files WHERE id=?1').bind(input.fileId!).first<{r2_key:string;mime:string;size_bytes:number;name:string}>();
    if(!file)throw invalidState('媒体原文件不存在');
    await env.DB.prepare("INSERT INTO media_processing(id,job_id,source_version_id,draft_file_id,config_version_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6) ON CONFLICT(job_id) DO NOTHING").bind(newId(),jobId,sourceVersionId??null,sourceVersionId?null:input.fileId!,config.id,nowIso()).run();
    state=await env.DB.prepare('SELECT * FROM media_processing WHERE job_id=?1').bind(jobId).first<State>();
    if(!state)throw invalidState('媒体任务状态缺失');
    if(state.stage==='uploading' || state.stage==='generating')throw invalidState('上次媒体请求受理状态未知，不会自动重放；请核对后主动重试');
    if(state.stage==='failed')throw invalidState('媒体处理已失败，请主动重新处理');
    if(!state.provider_name){
      const claim=await env.DB.prepare("UPDATE media_processing SET stage='uploading',updated_at=?2 WHERE id=?1 AND stage='pending'").bind(state.id,nowIso()).run();if(!claim.meta.changes)throw invalidState('媒体上传已在运行');
      const object=await env.FILES.get(file.r2_key);if(!object)throw invalidState('媒体原文件内容缺失');
      const uploaded=await client.upload(object.body,file.size_bytes,file.mime,file.name);
      await env.DB.prepare("UPDATE media_processing SET stage='processing',provider_name=?2,provider_uri=?3,cleanup_pending=1,updated_at=?4 WHERE id=?1").bind(state.id,uploaded.name,uploaded.uri,nowIso()).run();
      state.provider_name=uploaded.name;state.provider_uri=uploaded.uri;
    }
    let remote=await client.get(state.provider_name);
    for(let poll=0;remote.state==='PROCESSING' && poll<25;poll++){await assertActive();await new Promise(resolve=>setTimeout(resolve,2000));remote=await client.get(state.provider_name);}
    if(remote.state!=='ACTIVE')throw new AppError('AI_UNAVAILABLE','Google 媒体文件尚未可用或处理失败；请稍后主动重试',503,false);
    const duration=remote.videoMetadata?.videoDuration?Number.parseFloat(remote.videoMetadata.videoDuration):undefined;
    let windows=duration&&file.mime.startsWith('video/')?Array.from({length:Math.ceil(duration/600)},(_,i)=>({start:i*600,end:Math.min(duration,(i+1)*600)})):[{start:0,end:file.mime.startsWith('audio/')?600:undefined}];
    if(windows.length>24)throw invalidState('视频超过四小时处理上限；请拆分为较短文件');
    await env.DB.prepare('UPDATE media_processing SET duration_seconds=?2 WHERE id=?1').bind(state.id,duration??null).run();
    if(job.project_id)await reserveAiSlot(env,{projectId:job.project_id,jobId,purpose:'media_summary',configVersionId:config.id,maxCalls:windows.length});
    const completed=JSON.parse(state.windows_json) as MediaSummary[];
    for(let index=completed.length;index<windows.length;index++){
      await assertActive();const window=windows[index]!;
      await env.DB.prepare("UPDATE media_processing SET stage='generating',updated_at=?2 WHERE id=?1").bind(state.id,nowIso()).run();
      const callId=newId();await env.DB.prepare("INSERT INTO media_calls(id,job_id,config_version_id,model,window_start,window_end,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,'started',?7)").bind(callId,jobId,config.id,model.model,window.start,window.end??null,nowIso()).run();
      if(job.project_id)await markAiCallStarted(env,jobId);
      let result;
      try {result=await client.summarize(remote,file.mime,window.start,window.end);}catch(error){await env.DB.prepare("UPDATE media_calls SET status='unknown' WHERE id=?1").bind(callId).run();throw error;}
      const price=model.pricePerMTokens,cost=price&&result.promptTokens!==null&&result.completionTokens!==null?(result.promptTokens*price[0]+result.completionTokens*price[1])/1e6:null;
      await env.DB.prepare("UPDATE media_calls SET status='ok',prompt_tokens=?2,completion_tokens=?3,cost_usd=?4,cost_status=?5 WHERE id=?1").bind(callId,result.promptTokens,result.completionTokens,cost,cost===null?'unknown':'known').run();
      completed.push(result.summary);await env.DB.prepare("UPDATE media_processing SET windows_json=?2,summary_json=?3,stage='processing',updated_at=?4 WHERE id=?1").bind(state.id,JSON.stringify(completed),JSON.stringify({...result.summary,complete:false,caveats:[...result.summary.caveats,'处理中；尚未确认完整覆盖']}),nowIso()).run();
      if(file.mime.startsWith('audio/') && index===0){
        const audioDuration=result.summary.durationSeconds;
        if(!audioDuration)throw new AppError('AI_OUTPUT_INVALID','无法确认音频总时长；摘要按部分结果保留，请核对',422,false);
        if(audioDuration>14400)throw invalidState('音频超过四小时处理上限，请拆分');
        windows=Array.from({length:Math.ceil(audioDuration/600)},(_,i)=>({start:i*600,end:Math.min(audioDuration,(i+1)*600)}));
        await env.DB.prepare('UPDATE media_processing SET duration_seconds=?2 WHERE id=?1').bind(state.id,audioDuration).run();
        if(job.project_id)await env.DB.prepare("UPDATE usage_reservations SET max_calls=?2 WHERE job_id=?1 AND status='reserved'").bind(jobId,Math.max(2,windows.length)).run();
      }
      if(!result.summary.complete)throw new AppError('AI_OUTPUT_INVALID','媒体摘要未完整覆盖；部分结果已保留，请核对',422,false);

    }
    const summary=mediaSummarySchema.parse({title:completed[0]!.title,summary:completed.map(s=>s.summary).join('\n\n'),keyPoints:completed.flatMap(s=>s.keyPoints).slice(0,50),conclusions:completed.flatMap(s=>s.conclusions).slice(0,30),actionItems:completed.flatMap(s=>s.actionItems).slice(0,30),timestamps:completed.flatMap(s=>s.timestamps).slice(0,100),caveats:['这是 AI 摘要，不是逐字原文。',...completed.flatMap(s=>s.caveats)].slice(0,30),complete:true});
    const text=mediaSummaryText(summary);await assertActive();
    if(sourceVersionId){
      const active=await loadActiveSourceVersion(env,sourceVersionId,input.sourceLifecycleVersion),fragmentId=newId(),guard=sourceLifecycleGuard('?1','?2')+" AND EXISTS(SELECT 1 FROM jobs WHERE id=?3 AND status IN ('queued','running'))";
      const documentSummary={title:summary.title,summary:text,keyPoints:summary.keyPoints.length?summary.keyPoints:[summary.summary],citations:[{fragmentId,pageNumber:null,quote:'AI 摘要（非逐字原文）'}],caveats:summary.caveats};
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM source_fragments WHERE source_version_id=?1 AND ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId),
        env.DB.prepare(`INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) SELECT ?4,?1,?5,NULL,1,'text',?6,?7 WHERE ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,fragmentId,active.projectId,text,nowIso()),
        env.DB.prepare(`UPDATE source_versions SET char_count=?4,page_count=NULL,status='ready',parse_error=NULL WHERE id=?1 AND ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,text.length),
        env.DB.prepare(`INSERT INTO source_processing(source_version_id,project_id,text_status,summary_status,summary_json,summary_job_id,summary_revision,updated_at) SELECT ?1,?4,'ready','ready',?5,?3,1,?6 WHERE ${guard} ON CONFLICT(source_version_id) DO UPDATE SET text_status='ready',summary_status='ready',summary_json=excluded.summary_json,summary_job_id=excluded.summary_job_id,summary_revision=summary_revision+1,summary_error=NULL,updated_at=excluded.updated_at`).bind(sourceVersionId,active.lifecycleVersion,jobId,active.projectId,JSON.stringify(documentSummary),nowIso()),
      ]);
    }else{
      const saved=await env.DB.prepare("UPDATE creation_draft_files SET pages_json=?3,text_error=NULL WHERE id=?1 AND draft_id=?2 AND removed=0 AND EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?2 AND status='active') AND EXISTS(SELECT 1 FROM jobs WHERE id=?4 AND status IN ('queued','running'))").bind(input.fileId!,input.draftId!,JSON.stringify([text]),jobId).run();if(!saved.meta.changes)throw invalidState('草稿媒体生命周期已变化');
      await env.DB.prepare("UPDATE project_creation_drafts SET revision=revision+1,preview_state='none',updated_at=?2 WHERE id=?1 AND status='active'").bind(input.draftId!,nowIso()).run();
    }
    await env.DB.prepare("UPDATE media_processing SET stage='ready',summary_json=?2,error=NULL,updated_at=?3 WHERE id=?1").bind(state.id,JSON.stringify(summary),nowIso()).run();
    await settleReservation(env,jobId,'settled');await succeedJob(env,jobId,{mediaSummary:true,sourceVersionId:sourceVersionId??null,fileId:input.fileId??null});
  }catch(error){
    const message=error instanceof AppError?error.message:'媒体请求失败或受理状态未知；原文件保留，请核对后主动重试';
    if(state)await env.DB.prepare("UPDATE media_processing SET stage='failed',error=?2,updated_at=?3 WHERE id=?1").bind(state.id,message,nowIso()).run();
    if(!sourceVersionId&&input.fileId)await env.DB.prepare('UPDATE creation_draft_files SET text_error=?2 WHERE id=?1').bind(input.fileId,message).run();
    await settleReservation(env,jobId,'released');await failJob(env,jobId,{code:error instanceof AppError?error.code:'AI_UNAVAILABLE',message});
  }finally{
    if(client&&state?.provider_name){try{await client.remove(state.provider_name);await env.DB.prepare('UPDATE media_processing SET cleanup_pending=0 WHERE id=?1').bind(state.id).run();}catch{/* Cron retries cleanup without repeating generation. */}}
  }
  return {status:(await getJob(env,jobId)).status};
}
export async function cleanupMediaFiles(env:Env):Promise<void>{
  const rows=await env.DB.prepare("SELECT m.* FROM media_processing m JOIN jobs j ON j.id=m.job_id WHERE m.cleanup_pending=1 AND j.status IN ('succeeded','failed','cancelled') ORDER BY m.updated_at LIMIT 20").all<State>();
  for(const row of rows.results){try{const loaded=await loadAiConfig(env.DB,row.config_version_id),model=loaded?.config.mediaUnderstanding;if(!model?.apiKeyEncrypted||!row.provider_name)continue;await new GeminiMediaClient(model,await unseal(model.apiKeyEncrypted,env.AUTH_SECRET)).remove(row.provider_name);await env.DB.prepare('UPDATE media_processing SET cleanup_pending=0 WHERE id=?1').bind(row.id).run();}catch{/* Persisted for the next bounded cron pass. */}}
}
