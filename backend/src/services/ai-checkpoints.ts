import type { Env } from '../env';
import { checkpointSecret, seal, unseal } from '../ai/secrets';
import { invalidState } from '../core/errors';

/** Retries have new execution IDs but retain the original durable checkpoint namespace. */
export async function checkpointRootId(env:Env,jobId:string):Promise<string> {
  let id=jobId;const seen=new Set<string>();
  for(let depth=0;depth<100;depth++) {
    if(seen.has(id))throw invalidState('任务重试链无效');
    seen.add(id);
    const job=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1').bind(id).first<{input_json:string}>();
    const input=job?JSON.parse(job.input_json) as {checkpointRootId?:string}:{};
    if(input.checkpointRootId)return input.checkpointRootId;
    const parent=await env.DB.prepare('SELECT parent_job_id FROM admin_ai_retry_links WHERE retry_job_id=?1').bind(id).first<{parent_job_id:string}>();
    if(!parent)return id;
    id=parent.parent_job_id;
  }
  throw invalidState('任务重试链过长');
}
export async function allowsUncertainCheckpointRetry(env:Env,jobId?:string):Promise<boolean> {
  if(!jobId)return false;
  const job=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1').bind(jobId).first<{input_json:string}>();
  return !!job && JSON.parse(job.input_json).allowUncertainCheckpointRetry===true;
}
export async function checkpointFingerprint(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Encrypt every response, including non-private calls; bind each chunk to its key and index. */
export async function saveResponseCheckpoint(env:Env,key:string,value:unknown):Promise<void> {
  const characters=Array.from(JSON.stringify(value)),chunks:string[]=[],total=Math.ceil(characters.length/16000);
  for(let index=0;index<total;index++)chunks.push(await seal(JSON.stringify({key,index,total,data:characters.slice(index*16000,(index+1)*16000).join('')}),checkpointSecret(env)));
  await env.FILES.put(key,JSON.stringify({format:'encrypted-response-v1',chunks}),{httpMetadata:{contentType:'application/json'}});
}
export async function loadResponseCheckpoint<T>(env:Env,key:string):Promise<T|null> {
  const stored=await env.FILES.get(key);if(!stored)return null;
  const envelope=await stored.json<{format:string;chunks:string[]}>();
  if(envelope.format!=='encrypted-response-v1'||!envelope.chunks?.length)throw invalidState('响应检查点格式无效');
  let text='';
  for(let index=0;index<envelope.chunks.length;index++) {
    const chunk=JSON.parse(await unseal(envelope.chunks[index]!,checkpointSecret(env))) as {key:string;index:number;total:number;data:string};
    if(chunk.key!==key||chunk.index!==index||chunk.total!==envelope.chunks.length||typeof chunk.data!=='string')throw invalidState('响应检查点内容不匹配');
    text+=chunk.data;
  }
  return JSON.parse(text) as T;
}
