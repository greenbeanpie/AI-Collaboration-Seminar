import { recordActivity } from './ai-activity';
import { saveDraftCheckpoint } from './draft-preview-checkpoints';
import { loadAiConfig } from '../ai/config';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState } from '../core/errors';
import { getDraft, draftView, prepareDraftPreviewAttempt, type creationGoal, type creationTask } from './creation-drafts';
import { loadDraftCheckpoint } from './draft-preview-checkpoints';
import type { z } from 'zod';

export interface DraftPreviewInput {
  draftId:string;userId:string;revision:number;attempt:string;
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
  const input:DraftPreviewInput={draftId:row.draft_id,userId:draft.owner_id,revision:row.context_revision,attempt:row.attempt_id,tasks:[],goal:restored.checkpoint.requestedGoal};
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
  await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='failed',preview_error='后台预览已停止；若请求已发出，用量可能已产生，未自动重放。请核对后主动重新生成',updated_at=?4 WHERE id=?1 AND preview_attempt_id=?2 AND revision=?3 AND preview_state='running' AND preview_waiting_id IS NULL AND NOT EXISTS(SELECT 1 FROM draft_preview_dispatches newer WHERE newer.attempt_id=?2 AND newer.question_id IS NOT NULL AND (SELECT round FROM ai_clarifications WHERE id=newer.question_id)>COALESCE((SELECT round FROM ai_clarifications WHERE id=?5),0))").bind(row.draft_id,row.attempt_id,row.context_revision,nowIso(),row.question_id).run();
}

export async function enqueueDraftPreview(env:Env,id:string,userId:string,revision:number,tasks:DraftPreviewInput['tasks'],regenerate:boolean,goal?:DraftPreviewInput['goal']) {
  const row=await getDraft(env,id,userId);
  if(row.status!=='active'||row.revision!==revision)throw invalidState('草稿或权限已变化');
  if(row.preview_waiting_id) {
    if(regenerate)throw invalidState('请先回答或取消当前澄清问题，再重新生成预览');
    return draftView(env,row);
  }
  if(row.preview_state==='ready'&&row.preview_revision===revision&&!regenerate)return draftView(env,row);
  if(row.preview_state==='running'&&(!regenerate||Date.now()-Date.parse(row.updated_at)<660000))return draftView(env,row);
  const resume=regenerate&&row.preview_state==='failed'&&row.preview_attempt_id;
  const attempt=resume||newId(),now=nowIso();
  const snapshot=await prepareDraftPreviewAttempt(env,row,attempt,goal);
  const instanceId=resume?`${attempt}-manual-${newId()}`:attempt;
  if(resume){
    const config=await loadAiConfig(env.DB);
    if(!config?.enabled||config.id!==snapshot.checkpoint.configVersionId)throw invalidState('模型配置已变化，请重新发起预览');
    snapshot.checkpoint.pendingDispatch=false;
    await saveDraftCheckpoint(env,snapshot.checkpoint,snapshot.etag);
  }
  const result=await env.DB.batch([
    env.DB.prepare("UPDATE project_creation_drafts SET preview_state='running',preview_attempt_id=?4,preview_waiting_id=NULL,preview_error=NULL,preview_config_version_id=?9,updated_at=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_waiting_id IS NULL AND (preview_state!='running' OR (?6=1 AND preview_attempt_id IS ?7 AND updated_at=?8))").bind(id,userId,revision,attempt,now,regenerate?1:0,row.preview_attempt_id,row.updated_at,snapshot.checkpoint.configVersionId),
    env.DB.prepare("INSERT INTO draft_preview_dispatches(instance_id,draft_id,attempt_id,context_revision,status,created_at,updated_at) SELECT ?6,?1,?4,?3,'pending',?5,?5 WHERE EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?1 AND owner_id=?2 AND revision=?3 AND preview_attempt_id=?4 AND preview_state='running' AND status='active')").bind(id,userId,revision,attempt,now,instanceId)
  ]);
  if(!result[0]?.meta.changes)throw invalidState('预览状态已变化');
  await recordActivity(env,'draft:'+attempt,resume?'retrying':'reading_sources',resume?'resumed':'started',{completed:snapshot.checkpoint.step,unit:'step'});
  await dispatchDraftPreview(env,{instance_id:instanceId,draft_id:id,attempt_id:attempt,context_revision:revision,question_id:null,status:'pending',updated_at:now});
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
  const stale=await env.DB.prepare("SELECT s.* FROM draft_preview_dispatches s JOIN project_creation_drafts d ON d.id=s.draft_id WHERE s.status='dispatched' AND d.status='active' AND d.preview_attempt_id=s.attempt_id AND d.revision=s.context_revision AND d.preview_state='running' AND d.preview_waiting_id IS NULL AND d.updated_at<?1 ORDER BY s.updated_at DESC LIMIT 10").bind(new Date(Date.now()-660000).toISOString()).all<DraftDispatch>();
  for(const row of stale.results) {
    try {
      const instance=await env.AGENT_WORKFLOW.get(row.instance_id),status=await instance.status();
      if(['errored','terminated','complete'].includes(status.status))await failStoppedDispatch(env,row);
    }catch { /* Unknown engine status cannot authorize a duplicate execution. */ }
  }
}
