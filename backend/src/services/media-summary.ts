import { checkpointRootId, checkpointFingerprint, loadResponseCheckpoint, saveResponseCheckpoint } from './ai-checkpoints';
import { recordActivity } from './ai-activity';
import { aiSecret } from '../ai/secrets';
import { runAudioPipeline,whisperEnabled,audioFallbackConfigId } from './audio-pipeline';
import type { Env } from '../env';
import { loadAiConfig } from '../ai/config';
import { unseal } from '../ai/secrets';
import { GeminiMediaClient, mediaSummarySchema, mediaSummaryText, type MediaSummary } from '../ai/gemini-media';
import { nowIso, newId } from '../core/db';
import { AppError, invalidState } from '../core/errors';
import { createJobAndDispatch, getJob, failJob, succeedJob } from './jobs';
import { loadActiveSourceVersion, assertSourceJobActive, sourceLifecycleGuard } from './source-lifecycle';
import { reserveAiSlot, markAiCallStarted, settleReservation } from './ai-reservations';
import { MimoMediaClient } from '../ai/mimo-media';
import { mediaRouteError, selectedMediaProvider } from './media-routing';
import { createMediaFetchUrl } from './media-fetch';
import { diagnosticErrorCode, recordAiDiagnostic, safeBackendErrorReason } from '../ai/diagnostics';

interface State {id:string;job_id:string;source_version_id:string|null;draft_file_id:string|null;config_version_id:string;stage:string;provider:'gemini'|'mimo';provider_name:string|null;provider_uri:string|null;windows_json:string;summary_json:string|null;duration_seconds:number|null;}
export async function enqueueDraftMedia(env:Env,draftId:string,fileId:string,userId:string):Promise<void> {
  const config=await loadAiConfig(env.DB);
  const file=await env.DB.prepare('SELECT mime FROM creation_draft_files WHERE id=?1 AND draft_id=?2 AND removed=0').bind(fileId,draftId).first<{mime:string}>();
  const routeError=config&&file?mediaRouteError(env,config,file.mime):'音视频模型尚未配置；原文件已保留，可创建后处理';
  if(routeError) {
    await env.DB.prepare('UPDATE creation_draft_files SET text_error=?3 WHERE id=?1 AND draft_id=?2').bind(fileId,draftId,routeError).run();return;
  }
  await createJobAndDispatch(env,{projectId:null,kind:'agent_run',createdBy:userId,input:{operation:'media.draft',draftId,fileId,configVersionId:config!.id,mediaProvider:selectedMediaProvider(config!,file!.mime)}});
}
export async function runMediaJob(env:Env,jobId:string,sourceVersionId?:string,maxWindows=Infinity):Promise<{status:string}> {
  const job=await getJob(env,jobId),input=JSON.parse(job.input_json) as {draftId?:string;fileId?:string;configVersionId?:string;sourceLifecycleVersion?:number;mediaProvider?:'gemini'|'mimo'};
  if(['succeeded','failed','cancelled','waiting_input'].includes(job.status))return {status:job.status};
  const assertActive=async()=>{
    if(ownsLease&&state){const held=await env.DB.prepare('UPDATE media_processing SET lease_expires_at=?3 WHERE id=?1 AND lease_token=?2').bind(state.id,leaseToken,new Date(Date.now()+900000).toISOString()).run();if(!held.meta.changes)throw invalidState('媒体执行租约已变化');}
    const current=await getJob(env,jobId);if(!['queued','running'].includes(current.status))throw invalidState('媒体任务已停止');
    if(sourceVersionId){await loadActiveSourceVersion(env,sourceVersionId,input.sourceLifecycleVersion);await assertSourceJobActive(env,jobId);}
    else if(!await env.DB.prepare("SELECT 1 FROM creation_draft_files f JOIN project_creation_drafts d ON d.id=f.draft_id WHERE f.id=?1 AND d.id=?2 AND f.removed=0 AND d.status='active'").bind(input.fileId!,input.draftId!).first())throw invalidState('草稿或文件已删除、取消或提交');
  };
  let client:GeminiMediaClient|undefined,state:State|null=null,continuing=false,ownsLease=false,mimoRequest=input.mediaProvider==='mimo';const leaseToken=newId();
  try {
    await assertActive();
    await recordActivity(env,jobId,'reading_sources');
    const config=await loadAiConfig(env.DB,input.configVersionId);
    if(!config?.enabled)throw new AppError('AI_UNAVAILABLE','AI 尚未启用；原文件已保留',503,false);
    const fallbackId=await audioFallbackConfigId(env,jobId);
    const mediaConfig=fallbackId?await loadAiConfig(env.DB,fallbackId):config;
    const model=mediaConfig?.config.mediaUnderstanding;
    const file=sourceVersionId?await env.DB.prepare('SELECT f.r2_key,f.mime_detected AS mime,f.size_bytes,f.original_name AS name FROM source_versions v JOIN files f ON f.id=v.file_id WHERE v.id=?1').bind(sourceVersionId).first<{r2_key:string;mime:string;size_bytes:number;name:string}>():await env.DB.prepare('SELECT r2_key,mime,size_bytes,name FROM creation_draft_files WHERE id=?1').bind(input.fileId!).first<{r2_key:string;mime:string;size_bytes:number;name:string}>();
    if(!file)throw invalidState('媒体原文件不存在');
    const provider=fallbackId?'gemini':input.mediaProvider??selectedMediaProvider(config,file.mime);
    mimoRequest=provider==='mimo';
    await env.DB.prepare("INSERT INTO media_processing(id,job_id,source_version_id,draft_file_id,config_version_id,created_at,updated_at,provider) VALUES(?1,?2,?3,?4,?5,?6,?6,?7) ON CONFLICT(job_id) DO NOTHING").bind(newId(),jobId,sourceVersionId??null,sourceVersionId?null:input.fileId!,config.id,nowIso(),provider).run();
    state=await env.DB.prepare('SELECT * FROM media_processing WHERE job_id=?1').bind(jobId).first<State>();
    if(!state)throw invalidState('媒体任务状态缺失');
    mimoRequest=state.provider==='mimo';
    const lease=await env.DB.prepare("UPDATE media_processing SET lease_token=?2,lease_expires_at=?3 WHERE id=?1 AND (lease_token IS NULL OR lease_expires_at<?4) AND (?5 IS NOT NULL OR (SELECT COUNT(*) FROM media_processing m JOIN creation_draft_files f ON f.id=m.draft_file_id JOIN project_creation_drafts d ON d.id=f.draft_id WHERE d.owner_id=(SELECT owner_id FROM project_creation_drafts WHERE id=?6) AND m.lease_token IS NOT NULL AND m.lease_expires_at>=?4 AND m.id!=?1)<2)").bind(state.id,leaseToken,new Date(Date.now()+900000).toISOString(),nowIso(),sourceVersionId??null,input.draftId??null).run();
    if(!lease.meta.changes){continuing=true;return {status:'busy'};}ownsLease=true;
    // The previous owner may have completed a window between our read and lease claim.
    state=await env.DB.prepare('SELECT * FROM media_processing WHERE job_id=?1').bind(jobId).first<State>();
    if(!state)throw invalidState('媒体任务状态缺失');
    if(state.stage==='uploading' || state.stage==='generating')throw invalidState('上次媒体请求受理状态未知，不会自动重放；请核对后主动重试');
    if(state.stage==='ready'){await settleReservation(env,jobId,'settled');await succeedJob(env,jobId,{mediaSummary:true});return {status:(await getJob(env,jobId)).status};}
    if(state.stage==='failed')throw invalidState('媒体处理已失败，请主动重新处理');
    let summary:MediaSummary|undefined;
    if(!mimoRequest && (whisperEnabled(env,config,file.mime) || fallbackId)){
      if(job.project_id)await reserveAiSlot(env,{projectId:job.project_id,jobId,purpose:'audio_pipeline',configVersionId:config.id,maxCalls:64});
      await env.DB.prepare("UPDATE media_processing SET stage='processing' WHERE id=?1 AND stage='pending'").bind(state.id).run();
      const audio=await runAudioPipeline(env,{jobId,config,r2Key:file.r2_key,mime:file.mime,assertActive,maxSteps:maxWindows});
      if(audio.kind==='continue'||audio.kind==='waiting'){continuing=true;return {status:audio.kind==='continue'?'running':'waiting_input'};}
      if(audio.kind==='summary')summary=audio.summary;
    }
    if(!summary&&mimoRequest){
      const routeError=mediaRouteError(env,config,file.mime);if(routeError)throw invalidState(routeError);
      const mimoModel=config.config.mimoMediaUnderstanding!;
      if (!mimoModel.apiKeyEncrypted) throw new AppError('AI_UNAVAILABLE','MiMo API key 尚未配置',503,false);
      const mimo=new MimoMediaClient(mimoModel,await unseal(mimoModel.apiKeyEncrypted,aiSecret(env)),fetch,env,jobId);
      if(job.project_id)await reserveAiSlot(env,{projectId:job.project_id,jobId,purpose:'media_summary',configVersionId:config.id,maxCalls:2});
      await assertActive();
      const claim=await env.DB.prepare("UPDATE media_processing SET stage='generating',updated_at=?3 WHERE id=?1 AND lease_token=?2 AND stage IN ('pending','processing')").bind(state.id,leaseToken,nowIso()).run();
      if(!claim.meta.changes)throw invalidState('媒体请求已在运行，拒绝重放');
      const url=await createMediaFetchUrl(env,jobId);
      const callId=newId();
      await env.DB.prepare("INSERT INTO media_calls(id,job_id,config_version_id,model,window_start,status,provider,created_at) VALUES(?1,?2,?3,?4,0,'started','mimo',?5)").bind(callId,jobId,config.id,mimoModel.model,nowIso()).run();
      if(job.project_id)await markAiCallStarted(env,jobId);
      let result;
      try{await assertActive();await recordActivity(env,jobId,'summarizing');const key=`ai/media-responses/${await checkpointRootId(env,jobId)}/${await checkpointFingerprint([config.id,file.r2_key,file.mime,'mimo'])}.json`;const cached=await loadResponseCheckpoint<Awaited<ReturnType<typeof mimo.summarize>>>(env,key);if(cached){result=cached;}else{result=await mimo.summarize(url,file.mime);await saveResponseCheckpoint(env,key,result);}}catch(error){await env.DB.prepare("UPDATE media_calls SET status='unknown' WHERE id=?1").bind(callId).run();throw error;}
      await env.DB.prepare("UPDATE media_calls SET status='ok',prompt_tokens=?2,completion_tokens=?3,cached_tokens=?4,audio_tokens=?5,video_tokens=?6,window_end=?7 WHERE id=?1").bind(callId,result.promptTokens,result.completionTokens,result.cachedTokens,result.audioTokens,result.videoTokens,result.summary.durationSeconds??null).run();
      await assertActive();
      await env.DB.prepare("UPDATE media_processing SET summary_json=?3,duration_seconds=?4,windows_json=?5,updated_at=?6 WHERE id=?1 AND lease_token=?2 AND EXISTS(SELECT 1 FROM jobs WHERE id=media_processing.job_id AND status IN ('queued','running'))").bind(state.id,leaseToken,JSON.stringify(result.summary),result.summary.durationSeconds??null,JSON.stringify([result.summary]),nowIso()).run();
      if(!result.summary.complete)throw new AppError('AI_OUTPUT_INVALID','MiMo 摘要未完整覆盖；部分结果已保留，请核对原文件',422,false);
      summary=result.summary;
    }
    if(!summary){
    if(!model)throw new AppError('AI_UNAVAILABLE','音视频 Gemini 模型尚未配置；原文件已保留',503,false);
    if (!model.apiKeyEncrypted) throw new AppError('AI_UNAVAILABLE','Gemini API key 尚未配置',503,false);
    client=new GeminiMediaClient(model,await unseal(model.apiKeyEncrypted,aiSecret(env)),fetch,env,jobId);
    if(job.project_id)await reserveAiSlot(env,{projectId:job.project_id,jobId,purpose:'media_summary',configVersionId:mediaConfig!.id,maxCalls:24});
    if(!state.provider_name){
      const claim=await env.DB.prepare("UPDATE media_processing SET stage='uploading',updated_at=?2 WHERE id=?1 AND stage IN ('pending','processing')").bind(state.id,nowIso()).run();if(!claim.meta.changes)throw invalidState('媒体上传已在运行');
      const object=await env.FILES.get(file.r2_key);if(!object)throw invalidState('媒体原文件内容缺失');
      const uploaded=await client.upload(object.body,file.size_bytes,file.mime,file.name);
      state.provider_name=uploaded.name;state.provider_uri=uploaded.uri;
      await env.DB.prepare("UPDATE media_processing SET stage='processing',provider_name=?2,provider_uri=?3,cleanup_pending=1,updated_at=?4 WHERE id=?1").bind(state.id,uploaded.name,uploaded.uri,nowIso()).run();
      state.provider_name=uploaded.name;state.provider_uri=uploaded.uri;
    }
    let remote=await client.get(state.provider_name);
    for(let poll=0;remote.state==='PROCESSING' && poll<25;poll++){await assertActive();await new Promise(resolve=>setTimeout(resolve,2000));remote=await client.get(state.provider_name);}
    if(remote.state==='PROCESSING'){continuing=true;return {status:'running'};}
    if(remote.state!=='ACTIVE')throw new AppError('AI_UNAVAILABLE','Google 媒体文件尚未可用或处理失败；请稍后主动重试',503,false);
    if(file.mime.startsWith('video/')&&!remote.videoMetadata?.videoDuration&&!state.duration_seconds)throw new AppError('AI_OUTPUT_INVALID','无法确认视频时长，拒绝声称完整处理',422,false);
    const duration=remote.videoMetadata?.videoDuration?Number.parseFloat(remote.videoMetadata.videoDuration):state.duration_seconds??undefined;
    if(duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) throw new AppError('AI_OUTPUT_INVALID','媒体时长无效，无法确认完整覆盖',422,false);
    let windows=duration?Array.from({length:Math.ceil(duration/600)},(_,i)=>({start:i*600,end:Math.min(duration,(i+1)*600)})):[{start:0,end:file.mime.startsWith('audio/')?600:undefined}];
    if(windows.length>24)throw invalidState('视频超过四小时处理上限；请拆分为较短文件');
    await env.DB.prepare('UPDATE media_processing SET duration_seconds=?2 WHERE id=?1').bind(state.id,duration??null).run();
    if(job.project_id)await reserveAiSlot(env,{projectId:job.project_id,jobId,purpose:'media_summary',configVersionId:mediaConfig!.id,maxCalls:windows.length});
    const completed=JSON.parse(state.windows_json) as MediaSummary[];
    const startingWindow=completed.length;
    for(let index=completed.length;index<windows.length;index++){
      await assertActive();const window=windows[index]!;
      const held=await env.DB.prepare('UPDATE media_processing SET lease_expires_at=?3 WHERE id=?1 AND lease_token=?2').bind(state.id,leaseToken,new Date(Date.now()+900000).toISOString()).run();if(!held.meta.changes){continuing=true;return {status:'running'};}
      const generating=await env.DB.prepare("UPDATE media_processing SET stage='generating',updated_at=?2 WHERE id=?1 AND stage='processing'").bind(state.id,nowIso()).run();if(!generating.meta.changes)throw invalidState('媒体请求已在运行，拒绝重放');
      const allowance=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM audio_pipeline_calls WHERE job_id=?1)+(SELECT COUNT(*) FROM media_calls WHERE job_id=?1 AND model!='@cf/openai/whisper-large-v3-turbo') n WHERE EXISTS(SELECT 1 FROM audio_pipeline WHERE job_id=?1)").bind(jobId).first<{n:number}>();if(allowance&&allowance.n>=64)throw invalidState('达到音频任务总调用上限');
      const callId=newId();await env.DB.prepare("INSERT INTO media_calls(id,job_id,config_version_id,model,window_start,window_end,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,'started',?7)").bind(callId,jobId,mediaConfig!.id,model.model,window.start,window.end??null,nowIso()).run();
      if(job.project_id)await markAiCallStarted(env,jobId);
      let result;
      try {await recordActivity(env,jobId,'summarizing','started',{completed:index,total:windows.length,unit:'window'});const key=`ai/media-responses/${await checkpointRootId(env,jobId)}/${await checkpointFingerprint([mediaConfig!.id,file.r2_key,file.mime,window.start,window.end])}.json`;const cached=await loadResponseCheckpoint<Awaited<ReturnType<typeof client.summarize>>>(env,key);if(cached){result=cached;}else{result=await client.summarize(remote,file.mime,window.start,window.end);await saveResponseCheckpoint(env,key,result);}}catch(error){await env.DB.prepare("UPDATE media_calls SET status='unknown' WHERE id=?1").bind(callId).run();throw error;}
      await env.DB.prepare("UPDATE media_calls SET status='ok',prompt_tokens=?2,completion_tokens=?3 WHERE id=?1").bind(callId,result.promptTokens,result.completionTokens).run();
      await recordActivity(env,jobId,'saving');
      completed.push(result.summary);await env.DB.prepare("UPDATE media_processing SET windows_json=?2,summary_json=?3,stage='processing',updated_at=?4 WHERE id=?1").bind(state.id,JSON.stringify(completed),JSON.stringify({...result.summary,complete:false,caveats:[...result.summary.caveats,'处理中；尚未确认完整覆盖']}),nowIso()).run();
      await recordActivity(env,jobId,'summarizing','completed',{completed:completed.length,total:windows.length,unit:'window'});
      if(file.mime.startsWith('audio/') && index===0){
        const audioDuration=result.summary.durationSeconds;
        if(!audioDuration)throw new AppError('AI_OUTPUT_INVALID','无法确认音频总时长；摘要按部分结果保留，请核对',422,false);
        if(audioDuration>14400)throw invalidState('音频超过四小时处理上限，请拆分');
        windows=Array.from({length:Math.ceil(audioDuration/600)},(_,i)=>({start:i*600,end:Math.min(audioDuration,(i+1)*600)}));
        await env.DB.prepare('UPDATE media_processing SET duration_seconds=?2 WHERE id=?1').bind(state.id,audioDuration).run();
        if(job.project_id && !whisperEnabled(env,config,file.mime))await env.DB.prepare("UPDATE usage_reservations SET max_calls=?2 WHERE job_id=?1 AND status='reserved'").bind(jobId,Math.max(2,windows.length)).run();
      }
      if(!result.summary.complete)throw new AppError('AI_OUTPUT_INVALID','媒体摘要未完整覆盖；部分结果已保留，请核对',422,false);
      if(index-startingWindow+1>=maxWindows && completed.length<windows.length){continuing=true;return {status:'running'};}

    }
    summary=mediaSummarySchema.parse({title:completed[0]!.title,summary:completed.map(s=>s.summary).join('\n\n'),keyPoints:completed.flatMap(s=>s.keyPoints).slice(0,50),conclusions:completed.flatMap(s=>s.conclusions).slice(0,30),actionItems:completed.flatMap(s=>s.actionItems).slice(0,30),timestamps:completed.flatMap(s=>s.timestamps).slice(0,100),caveats:['这是 AI 摘要，不是逐字原文。',...completed.flatMap(s=>s.caveats)].slice(0,30),complete:true});
    }
    await recordActivity(env,jobId,'saving');
    const text=mediaSummaryText(summary);await assertActive();
    if(sourceVersionId){
      const active=await loadActiveSourceVersion(env,sourceVersionId,input.sourceLifecycleVersion),fragmentId=newId(),guard=sourceLifecycleGuard('?1','?2')+" AND EXISTS(SELECT 1 FROM jobs WHERE id=?3 AND status IN ('queued','running')) AND EXISTS(SELECT 1 FROM media_processing WHERE job_id=?3 AND lease_token=?8)";
      const documentSummary={title:summary.title,summary:text,keyPoints:summary.keyPoints.length?summary.keyPoints:[summary.summary],citations:[{fragmentId,pageNumber:null,quote:'AI 摘要（非逐字原文）'}],caveats:summary.caveats};
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM resource_index_blocks WHERE version_id=?1 AND resource_type='source' AND project_id=(SELECT project_id FROM source_versions WHERE id=?1) AND ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,null,null,null,null,leaseToken),
        env.DB.prepare(`DELETE FROM resource_index_state WHERE version_id=?1 AND resource_type='source' AND project_id=(SELECT project_id FROM source_versions WHERE id=?1) AND ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,null,null,null,null,leaseToken),
        env.DB.prepare(`DELETE FROM source_fragments WHERE source_version_id=?1 AND ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,null,null,null,null,leaseToken),
        env.DB.prepare(`INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) SELECT ?4,?1,?5,NULL,1,'text',?6,?7 WHERE ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,fragmentId,active.projectId,text,nowIso(),leaseToken),
        env.DB.prepare(`UPDATE source_versions SET char_count=?4,page_count=NULL,status='ready',parse_error=NULL WHERE id=?1 AND ${guard}`).bind(sourceVersionId,active.lifecycleVersion,jobId,text.length,null,null,null,leaseToken),
        env.DB.prepare(`INSERT INTO source_processing(source_version_id,project_id,text_status,summary_status,summary_json,summary_job_id,summary_revision,updated_at) SELECT ?1,?4,'ready','ready',?5,?3,1,?6 WHERE ${guard} ON CONFLICT(source_version_id) DO UPDATE SET text_status='ready',summary_status='ready',summary_json=excluded.summary_json,summary_job_id=excluded.summary_job_id,summary_revision=summary_revision+1,summary_error=NULL,updated_at=excluded.updated_at`).bind(sourceVersionId,active.lifecycleVersion,jobId,active.projectId,JSON.stringify(documentSummary),nowIso(),null,leaseToken),
      ]);
    }else{
      const saved=await env.DB.batch([
        env.DB.prepare("UPDATE creation_draft_files SET pages_json=?3,text_error=NULL WHERE id=?1 AND draft_id=?2 AND removed=0 AND EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?2 AND status='active') AND EXISTS(SELECT 1 FROM jobs WHERE id=?4 AND status IN ('queued','running')) AND EXISTS(SELECT 1 FROM media_processing WHERE job_id=?4 AND lease_token=?5)").bind(input.fileId!,input.draftId!,JSON.stringify([text]),jobId,leaseToken),
        env.DB.prepare("UPDATE project_creation_drafts SET revision=revision+1,preview_state='none',updated_at=?2 WHERE id=?1 AND status='active' AND EXISTS(SELECT 1 FROM creation_draft_files WHERE id=?3 AND draft_id=?1 AND removed=0 AND pages_json=?4) AND EXISTS(SELECT 1 FROM jobs WHERE id=?5 AND status IN ('queued','running')) AND EXISTS(SELECT 1 FROM media_processing WHERE job_id=?5 AND lease_token=?6)").bind(input.draftId!,nowIso(),input.fileId!,JSON.stringify([text]),jobId,leaseToken),
      ]);if(!saved[0]?.meta.changes)throw invalidState('草稿媒体生命周期已变化');
    }
    await assertActive();
    const finalized=await env.DB.prepare("UPDATE media_processing SET stage='ready',summary_json=?2,error=NULL,updated_at=?3 WHERE id=?1 AND lease_token=?4").bind(state.id,JSON.stringify(summary),nowIso(),leaseToken).run();
    if(!finalized.meta.changes){ownsLease=false;return {status:'busy'};}
    await env.DB.prepare("UPDATE audio_pipeline SET phase='ready',final_summary_json=?2,updated_at=?3 WHERE job_id=?1 AND phase='fallback'").bind(jobId,JSON.stringify(summary),nowIso()).run();
    await settleReservation(env,jobId,'settled');await succeedJob(env,jobId,{mediaSummary:true,sourceVersionId:sourceVersionId??null,fileId:input.fileId??null});
  }catch(error){
    if(ownsLease&&state){
      const held=await env.DB.prepare('SELECT 1 FROM media_processing WHERE id=?1 AND lease_token=?2').bind(state.id,leaseToken).first();
      if(!held){ownsLease=false;return {status:'busy'};}
    }
    const message=error instanceof AppError?error.message:'媒体请求失败或受理状态未知；原文件保留，请核对后主动重试';
    await recordAiDiagnostic(env,{requestId:jobId,operation:'model_call',phase:'model_result',status:'failed',durationMs:0,errorCode:diagnosticErrorCode(error),errorReason:(safeBackendErrorReason(error instanceof AppError?error:undefined)??message).slice(0,240)});
    if(state&&ownsLease){const failed=await env.DB.prepare("UPDATE media_processing SET stage='failed',error=?2,updated_at=?3 WHERE id=?1 AND lease_token=?4").bind(state.id,message,nowIso(),leaseToken).run();if(!failed.meta.changes){ownsLease=false;return {status:'busy'};}}
    if(sourceVersionId){const lifecycle=input.sourceLifecycleVersion??1;const guard=sourceLifecycleGuard('?1','?2')+" AND EXISTS(SELECT 1 FROM jobs WHERE id=?4 AND status IN ('queued','running'))";await env.DB.batch([env.DB.prepare(`UPDATE source_versions SET status='failed',parse_error=?3 WHERE id=?1 AND ${guard}`).bind(sourceVersionId,lifecycle,message,jobId),env.DB.prepare(`INSERT INTO source_processing(source_version_id,project_id,text_status,summary_status,summary_error,updated_at) SELECT id,project_id,'failed','failed',?3,?5 FROM source_versions WHERE id=?1 AND ${guard} ON CONFLICT(source_version_id) DO UPDATE SET text_status='failed',summary_status='failed',summary_error=excluded.summary_error,updated_at=excluded.updated_at`).bind(sourceVersionId,lifecycle,message,jobId,nowIso())]);}
    if(!sourceVersionId&&input.fileId)await env.DB.prepare("UPDATE creation_draft_files SET text_error=?2 WHERE id=?1 AND removed=0 AND EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=creation_draft_files.draft_id AND status='active') AND EXISTS(SELECT 1 FROM jobs WHERE id=?3 AND status IN ('queued','running'))").bind(input.fileId,message,jobId).run();
    await settleReservation(env,jobId,'released');await failJob(env,jobId,{code:error instanceof AppError?error.code:'AI_UNAVAILABLE',message,...(mimoRequest?{details:{automaticRetry:false}}:{})});
  }finally{
    if(ownsLease&&state)await env.DB.prepare('UPDATE media_processing SET lease_token=NULL,lease_expires_at=NULL WHERE id=?1 AND lease_token=?2').bind(state.id,leaseToken).run();
    if(ownsLease&&!continuing&&client&&state?.provider_name){try{await client.remove(state.provider_name);await env.DB.prepare('UPDATE media_processing SET cleanup_pending=0 WHERE id=?1').bind(state.id).run();}catch{/* Cron retries cleanup without repeating generation. */}}
  }
  return {status:(await getJob(env,jobId)).status};
}
export async function cleanupMediaFiles(env:Env):Promise<void>{
  const rows=await env.DB.prepare("SELECT m.* FROM media_processing m JOIN jobs j ON j.id=m.job_id WHERE m.provider='gemini' AND m.cleanup_pending=1 AND j.status IN ('succeeded','failed','cancelled') ORDER BY m.updated_at LIMIT 20").all<State>();
  for(const row of rows.results){try{const loaded=await loadAiConfig(env.DB,row.config_version_id),model=loaded?.config.mediaUnderstanding;if(!model?.apiKeyEncrypted||!row.provider_name)continue;await new GeminiMediaClient(model,await unseal(model.apiKeyEncrypted,aiSecret(env)),fetch,env,row.id).remove(row.provider_name);await env.DB.prepare('UPDATE media_processing SET cleanup_pending=0 WHERE id=?1').bind(row.id).run();}catch{/* Persisted for the next bounded cron pass. */}}
}
