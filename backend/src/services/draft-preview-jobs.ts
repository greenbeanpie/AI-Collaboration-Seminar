import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState } from '../core/errors';
import { requireEnabledAiConfig } from '../ai/config';
import { getDraft, draftView, type creationGoal, type creationTask } from './creation-drafts';
import type { z } from 'zod';

export interface DraftPreviewInput {
  draftId:string;userId:string;revision:number;attempt:string;
  tasks:z.infer<typeof creationTask>[];goal?:z.infer<typeof creationGoal>;
}

export async function enqueueDraftPreview(env:Env,id:string,userId:string,revision:number,tasks:DraftPreviewInput['tasks'],regenerate:boolean,goal?:DraftPreviewInput['goal']) {
  const row=await getDraft(env,id,userId);
  if(row.status!=='active'||row.revision!==revision)throw invalidState('草稿或权限已变化');
  if(row.preview_state==='ready'&&row.preview_revision===revision&&!regenerate)return draftView(env,row);
  if(row.preview_state==='running')return draftView(env,row);
  await requireEnabledAiConfig(env.DB);
  const payload=JSON.parse(row.payload_json);
  if(!payload.aiCollaborationEnabled)throw invalidState('请先开启 AI 协作');
  const attempt=newId();
  const claim=await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='running',preview_attempt_id=?4,preview_error=NULL,updated_at=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_state!='running'").bind(id,userId,revision,attempt,nowIso()).run();
  if(!claim.meta.changes)throw invalidState('预览状态已变化');
  try {
    await env.AGENT_WORKFLOW.create({id:attempt,params:{jobId:attempt,draftPreview:{draftId:id,userId,revision,tasks,goal,attempt}}});
  } catch {
    await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='failed',preview_error='后台预览未能派发，请重试',updated_at=?3 WHERE id=?1 AND preview_attempt_id=?2 AND preview_state='running'").bind(id,attempt,nowIso()).run();
    throw invalidState('后台预览派发失败；草稿和文件已保留');
  }
  return draftView(env,await getDraft(env,id,userId));
}
