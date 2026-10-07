import { recordActivity } from './ai-activity';
import { saveDraftCheckpoint } from './draft-preview-checkpoints';
import { ensureExecution, readExecution, resumeExecution, cancelExecution, markInterruptedExecution } from './ai-execution-control';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState } from '../core/errors';
import { getDraft, draftView, prepareDraftPreviewAttempt, type creationGoal, type creationTask } from './creation-drafts';
import { loadDraftCheckpoint } from './draft-preview-checkpoints';
import type { z } from 'zod';

export interface DraftPreviewInput {
  draftId:string;userId:string;revision:number;attempt:string;
  generation?:number;segment?:number;
  tasks:z.infer<typeof creationTask>[];goal?:z.infer<typeof creationGoal>;
}
interface DraftDispatch {instance_id:string;draft_id:string;attempt_id:string;context_revision:number;question_id:string|null;status:string;updated_at:string}
const unavailableMessage='后台派发暂未确认，草稿与回答已保存，将自动核对恢复；不需要重复填写';

/** Reusing a deterministic Workflow ID handles a lost create response without a second runner. */
export async function dispatchDraftPreview(env:Env,dispatch:DraftDispatch):Promise<boolean> {
  const row=await env.DB.prepare("SELECT * FROM draft_preview_dispatches WHERE instance_id=?1 AND status='pending'").bind(dispatch.instance_id).first<DraftDispatch>();
  if(!row)return false;
  const draft=await env.DB.prepare("SELECT owner_id FROM project_creation_drafts WHERE id=?1 AND status='active' AND revision=?2 AND preview_attempt_id=?3 AND preview_state='running' AND preview_waiting_id IS NULL").bind(row.draft_id,row.context_revision,row.attempt_id).first<{owner_id:string}>();
  if(!draft)return false;
  const restored=await loadDraftCheckpoint(env,row.attempt_id);
  if(!restored||restored.checkpoint.draftId!==row.draft_id||restored.checkpoint.userId!==draft.owner_id||restored.checkpoint.revision!==row.context_revision)throw invalidState('预览恢复内容已变化，请重新预览');
  const execution=await ensureExecution(env,{kind:'draft_preview',id:row.attempt_id},{draftId:row.draft_id,userId:draft.owner_id});
  if(!['running','finalizing'].includes(execution.state))return false;
  const segment=restored.checkpoint.segment??0;
  if(row.instance_id.includes('-g')&&row.instance_id!==`${row.attempt_id}-g${execution.generation}-s${segment}`)return false;
  if(restored.checkpoint.dispatchInstanceId!==row.instance_id||restored.checkpoint.dispatchGeneration!==execution.generation||restored.checkpoint.dispatchSegment!==segment){restored.checkpoint.dispatchInstanceId=row.instance_id;restored.checkpoint.dispatchGeneration=execution.generation;restored.checkpoint.dispatchSegment=segment;await saveDraftCheckpoint(env,restored.checkpoint,restored.etag);}
  const input:DraftPreviewInput={generation:execution.generation,segment,draftId:row.draft_id,userId:draft.owner_id,revision:row.context_revision,attempt:row.attempt_id,tasks:[],goal:restored.checkpoint.requestedGoal};
  let terminal=false;
  try {
    await env.AGENT_WORKFLOW.create({id:row.instance_id,params:{jobId:input.attempt,draftPreview:input}});
  } catch {
    try {
      const instance=await env.AGENT_WORKFLOW.get(row.instance_id),status=await instance.status();
      terminal=['errored','terminated'].includes(status.status);
    } catch {
      // Keep the durable intent pending. Cron retries this exact Workflow ID only.
      await env.DB.batch([
        env.DB.prepare("UPDATE project_creation_drafts SET preview_error=?4 WHERE id=?1 AND preview_attempt_id=?2 AND revision=?3 AND preview_state='running' AND preview_waiting_id IS NULL").bind(row.draft_id,row.attempt_id,row.context_revision,unavailableMessage),
        env.DB.prepare("UPDATE draft_preview_dispatches SET updated_at=?2 WHERE instance_id=?1 AND status='pending'").bind(row.instance_id,nowIso())
      ]);
      return false;
    }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE draft_preview_dispatches SET status='dispatched',updated_at=?2 WHERE instance_id=?1 AND status='pending'").bind(row.instance_id,nowIso()),
    env.DB.prepare("UPDATE project_creation_drafts SET preview_error=NULL WHERE id=?1 AND preview_attempt_id=?2 AND preview_error=?3").bind(row.draft_id,row.attempt_id,unavailableMessage)
  ]);
  if(terminal)await failStoppedDispatch(env,row);
  return true;
}
async function failStoppedDispatch(env:Env,row:DraftDispatch) {
  const snapshot=await loadDraftCheckpoint(env,row.attempt_id),target={kind:'draft_preview' as const,id:row.attempt_id};
  const current=await env.DB.prepare("SELECT owner_id FROM project_creation_drafts WHERE id=?1 AND preview_attempt_id=?2 AND revision=?3 AND status='active' AND preview_state='running'").bind(row.draft_id,row.attempt_id,row.context_revision).first<{owner_id:string}>();
  if(!current)return;
  const execution=await readExecution(env,target)??await ensureExecution(env,target,{draftId:row.draft_id,userId:current.owner_id});
  if(!['running','finalizing'].includes(execution.state))return;
  if(!snapshot){await markInterruptedExecution(env,target,execution.generation);await env.DB.prepare("UPDATE project_creation_drafts SET preview_error='恢复检查点不存在；资料仍保留，请主动重新生成预览' WHERE id=?1 AND preview_attempt_id=?2").bind(row.draft_id,row.attempt_id).run();return;}
  const checkpoint=snapshot.checkpoint,segment=checkpoint.segment??0;
  const currentId=checkpoint.dispatchGeneration===execution.generation&&checkpoint.dispatchSegment===segment?checkpoint.dispatchInstanceId:`${row.attempt_id}-g${execution.generation}-s${segment}`;
  if(!checkpoint.dispatchInstanceId&&execution.generation===1&&segment===0){
    const latest=await env.DB.prepare("SELECT s.instance_id FROM draft_preview_dispatches s LEFT JOIN ai_clarifications q ON q.id=s.question_id WHERE s.attempt_id=?1 ORDER BY COALESCE(q.round,0) DESC,s.created_at DESC LIMIT 1").bind(row.attempt_id).first<{instance_id:string}>();
    if(latest?.instance_id!==row.instance_id)return;
  }else if(row.instance_id!==currentId)return;
  await markInterruptedExecution(env,target,execution.generation,{requestUncertain:checkpoint.pendingDispatch===true});
}

export async function enqueueDraftPreview(env:Env,id:string,userId:string,revision:number,tasks:DraftPreviewInput['tasks'],regenerate:boolean,goal?:DraftPreviewInput['goal']) {
  const row=await getDraft(env,id,userId);
  if(row.status!=='active'||row.revision!==revision)throw invalidState('草稿或权限已变化');
  if(row.preview_waiting_id) {
    if(regenerate)throw invalidState('请先回答或取消当前澄清问题，再重新生成预览');
    return draftView(env,row);
  }
  if(row.preview_state==='ready'&&row.preview_revision===revision&&!regenerate)return draftView(env,row);
  if(row.preview_state==='running'&&!regenerate)return draftView(env,row);
  const attempt=newId(),now=nowIso();
  const snapshot=await prepareDraftPreviewAttempt(env,row,attempt,goal);
  const execution=await ensureExecution(env,{kind:'draft_preview',id:attempt},{draftId:id,userId});
  const instanceId=`${attempt}-g${execution.generation}-s0`;
  const result=await env.DB.batch([
    env.DB.prepare("UPDATE project_creation_drafts SET preview_state='running',preview_attempt_id=?4,preview_waiting_id=NULL,preview_error=NULL,preview_config_version_id=?9,updated_at=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_waiting_id IS NULL AND (preview_state!='running' OR (?6=1 AND preview_attempt_id IS ?7 AND updated_at=?8))").bind(id,userId,revision,attempt,now,regenerate?1:0,row.preview_attempt_id,row.updated_at,snapshot.checkpoint.configVersionId),
    env.DB.prepare("INSERT INTO draft_preview_dispatches(instance_id,draft_id,attempt_id,context_revision,status,created_at,updated_at) SELECT ?6,?1,?4,?3,'pending',?5,?5 WHERE EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?1 AND owner_id=?2 AND revision=?3 AND preview_attempt_id=?4 AND preview_state='running' AND status='active')").bind(id,userId,revision,attempt,now,instanceId)
  ]);
  if(!result[0]?.meta.changes)throw invalidState('预览状态已变化');
  await recordActivity(env,'draft:'+attempt,'reading_sources','started',{completed:snapshot.checkpoint.step,unit:'step'});
  await dispatchDraftPreview(env,{instance_id:instanceId,draft_id:id,attempt_id:attempt,context_revision:revision,question_id:null,status:'pending',updated_at:now});
  return draftView(env,await getDraft(env,id,userId));
}

/** A persisted checkpoint authorizes only its deterministic next instance. */
export async function enqueueDraftPreviewSegment(env:Env,input:DraftPreviewInput) {
  const row=await getDraft(env,input.draftId,input.userId);
  const restored=await loadDraftCheckpoint(env,input.attempt),execution=await readExecution(env,{kind:'draft_preview',id:input.attempt});
  if(!restored||row.status!=='active'||row.preview_attempt_id!==input.attempt||row.revision!==input.revision||row.preview_state!=='running'||row.preview_waiting_id||!execution||!['running','finalizing'].includes(execution.state))return;
  if(input.generation!==undefined&&input.generation!==execution.generation)return;
  const current=restored.checkpoint,instanceId=current.dispatchGeneration===execution.generation&&current.dispatchSegment===(current.segment??0)&&current.dispatchInstanceId?current.dispatchInstanceId:`${input.attempt}-g${execution.generation}-s${current.segment??0}`,now=nowIso();
  await env.DB.prepare("INSERT OR IGNORE INTO draft_preview_dispatches(instance_id,draft_id,attempt_id,context_revision,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'pending',?5,?5)").bind(instanceId,input.draftId,input.attempt,input.revision,now).run();
  await dispatchDraftPreview(env,{instance_id:instanceId,draft_id:input.draftId,attempt_id:input.attempt,context_revision:input.revision,question_id:null,status:'pending',updated_at:now});
}

export async function controlDraftExecution(env:Env,id:string,userId:string,expectedGeneration:number,action:'continue'|'output'|'cancel',options:{allowUncertainDispatch?:boolean}={}) {
  const row=await getDraft(env,id,userId);
  if(row.status!=='active'||!row.preview_attempt_id)throw invalidState('草稿没有可控制的执行');
  if(action==='cancel') {
    const execution=await readExecution(env,{kind:'draft_preview',id:row.preview_attempt_id});
    if(execution?.state==='cancelled'&&execution.generation===expectedGeneration)return draftView(env,row);
  }
  if(row.preview_state!=='running')throw invalidState('草稿没有可控制的执行');
  const snapshot=await loadDraftCheckpoint(env,row.preview_attempt_id);
  if(!snapshot||snapshot.checkpoint.revision!==row.revision)throw invalidState('草稿版本已变化');
  const target={kind:'draft_preview' as const,id:row.preview_attempt_id};
  if(action==='cancel') {
    await cancelExecution(env,target,expectedGeneration);
    await env.DB.batch([
      env.DB.prepare("UPDATE project_creation_drafts SET preview_state='none',preview_waiting_id=NULL,preview_error=NULL,updated_at=?4 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_attempt_id=?5").bind(id,userId,row.revision,nowIso(),row.preview_attempt_id),
      env.DB.prepare("UPDATE ai_clarifications SET status='cancelled',revision=revision+1,updated_at=?2 WHERE draft_id=?1 AND status='pending' AND owner_id=?3").bind(id,nowIso(),userId)
    ]);
  }
  else {
    const execution=await resumeExecution(env,target,expectedGeneration,action,options);
    if(action==='output'&&snapshot.checkpoint.pendingOutput?.toolOutput) {
      const out=snapshot.checkpoint.pendingOutput.toolOutput;
      snapshot.checkpoint.exchanges.push({assistant:out.assistant,results:out.toolCalls.map(call=>snapshot.checkpoint.pendingResults?.find(result=>result.call.id===call.id)??{call,output:{skipped:true,reason:'用户要求基于已有资料输出'}})});
      snapshot.checkpoint.pendingOutput=undefined;snapshot.checkpoint.pendingResults=[];
      await saveDraftCheckpoint(env,snapshot.checkpoint,snapshot.etag);
      snapshot.etag=(await loadDraftCheckpoint(env,row.preview_attempt_id))!.etag;
    }
    // Keep completed provider output and tool results intact when a window resumes.
    if(snapshot.checkpoint.pendingDispatch||snapshot.checkpoint.providerRetry){snapshot.checkpoint.pendingDispatch=false;snapshot.checkpoint.providerRetry=undefined;await saveDraftCheckpoint(env,snapshot.checkpoint,snapshot.etag);}
    await enqueueDraftPreviewSegment(env,{draftId:id,userId,revision:row.revision,attempt:row.preview_attempt_id,generation:execution.generation,tasks:[]});
  }
  return draftView(env,await getDraft(env,id,userId));
}

/** The shared answer transaction already persisted this continuation's dispatch intent. */
export async function enqueueDraftContinuation(env:Env,id:string,userId:string,attempt:string,questionId:string) {
  const row=await getDraft(env,id,userId);
  if(row.status!=='active'||row.preview_attempt_id!==attempt||row.preview_state!=='running'||row.preview_waiting_id)return draftView(env,row);
  const dispatch=await env.DB.prepare("SELECT * FROM draft_preview_dispatches WHERE instance_id=?1 AND draft_id=?2 AND attempt_id=?3 AND status='pending'").bind(`${attempt}-q-${questionId}`,id,attempt).first<DraftDispatch>();
  if(dispatch)await dispatchDraftPreview(env,dispatch);
  return draftView(env,await getDraft(env,id,userId));
}

/** Scheduled recovery is read/dispatch-only; never replay a completed/uncertain paid call. */
export async function recoverDraftPreviews(env:Env):Promise<void> {
  await env.DB.prepare("UPDATE draft_preview_dispatches SET status='cancelled',updated_at=?1 WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM project_creation_drafts d WHERE d.id=draft_id AND d.status='active' AND d.preview_attempt_id=attempt_id AND d.revision=context_revision AND d.preview_state='running')").bind(nowIso()).run();
  const pending=await env.DB.prepare("SELECT s.* FROM draft_preview_dispatches s JOIN project_creation_drafts d ON d.id=s.draft_id WHERE s.status='pending' AND d.status='active' AND d.preview_attempt_id=s.attempt_id AND d.revision=s.context_revision AND d.preview_state='running' AND d.preview_waiting_id IS NULL ORDER BY s.updated_at LIMIT 10").all<DraftDispatch>();
  for(const row of pending.results) {
    try {await dispatchDraftPreview(env,row);}catch { /* An unavailable dependency retains durable intent for the next cron. */ }
  }
  const resumable=await env.DB.prepare("SELECT id,owner_id,revision,preview_attempt_id FROM project_creation_drafts WHERE status='active' AND preview_state='running' AND preview_waiting_id IS NULL ORDER BY updated_at LIMIT 20").all<{id:string;owner_id:string;revision:number;preview_attempt_id:string}>();
  for(const draft of resumable.results) {
    try {const snapshot=await loadDraftCheckpoint(env,draft.preview_attempt_id);if(snapshot&&!snapshot.checkpoint.pendingDispatch&&(snapshot.checkpoint.segment??0)>0)await enqueueDraftPreviewSegment(env,{draftId:draft.id,userId:draft.owner_id,revision:draft.revision,attempt:draft.preview_attempt_id,tasks:[]});}catch { /* Durable checkpoint recovery retries on the next scheduled tick. */ }
  }
  const stale=await env.DB.prepare("SELECT s.* FROM draft_preview_dispatches s JOIN project_creation_drafts d ON d.id=s.draft_id WHERE s.status='dispatched' AND d.status='active' AND d.preview_attempt_id=s.attempt_id AND d.revision=s.context_revision AND d.preview_state='running' AND d.preview_waiting_id IS NULL AND d.updated_at<?1 ORDER BY s.updated_at DESC LIMIT 10").bind(new Date(Date.now()-660000).toISOString()).all<DraftDispatch>();
  for(const row of stale.results) {
    try {
      const instance=await env.AGENT_WORKFLOW.get(row.instance_id),status=await instance.status();
      if(['errored','terminated','complete'].includes(status.status))await failStoppedDispatch(env,row);
    }catch { /* Unknown engine status cannot authorize a duplicate execution. */ }
  }
}
