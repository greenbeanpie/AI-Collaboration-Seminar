import type { Env } from '../env';
import { invalidState } from '../core/errors';
import { createJobAndDispatch } from './jobs';
import { loadActiveSourceVersion } from './source-lifecycle';

/** Text preparation is a separate source job; it never borrows an investigator's paid reservation. */
export async function prepareSourceText(env:Env,projectId:string,versionId:string,userId?:string):Promise<void> {
  const source=await loadActiveSourceVersion(env,versionId);
  if(source.projectId!==projectId)throw invalidState('来源不属于当前项目');
  const ready=await env.DB.prepare("SELECT 1 FROM source_versions v LEFT JOIN source_processing p ON p.source_version_id=v.id WHERE v.id=?1 AND (p.text_status='ready' OR (p.source_version_id IS NULL AND v.status='ready'))").bind(versionId).first();
  if(ready)return;
  const pending=await env.DB.prepare("SELECT id FROM jobs WHERE project_id=?1 AND json_extract(input_json,'$.sourceVersionId')=?2 AND kind IN ('parse_source','ocr_pages','requirement_extract','web_fetch') AND status IN ('queued','running','waiting_input') AND COALESCE(json_extract(input_json,'$.operation'),'')!='source.summary' ORDER BY created_at DESC LIMIT 1").bind(projectId,versionId).first<{id:string}>();
  const jobId=pending?.id??await createJobAndDispatch(env,{projectId,kind:'parse_source',createdBy:userId??null,input:{operation:'source.text',sourceId:source.sourceId,sourceVersionId:versionId,sourceLifecycleVersion:source.lifecycleVersion,phase:'extract'}});
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline){
    await loadActiveSourceVersion(env,versionId,source.lifecycleVersion);
    const stage=await env.DB.prepare('SELECT text_status FROM source_processing WHERE source_version_id=?1').bind(versionId).first<{text_status:string}>();
    if(stage?.text_status==='ready')return;
    const job=await env.DB.prepare('SELECT status,error_json FROM jobs WHERE id=?1 AND project_id=?2').bind(jobId,projectId).first<{status:string;error_json:string|null}>();
    if(!job||['failed','cancelled','waiting_input'].includes(job.status))throw invalidState(job?.status==='waiting_input'?'来源存在缺页或待识别图片，请在资料页面补齐识别后继续':'来源正文准备失败，原文件已保留');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw invalidState('来源正文仍在后台准备；文件已保留，请稍后重新发起调查');
}
