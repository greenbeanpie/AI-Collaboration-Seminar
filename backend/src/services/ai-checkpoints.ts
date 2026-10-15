import type { Env } from '../env';
import { checkpointSecret, sealChunkedEnvelope, unsealChunkedEnvelope } from '../ai/secrets';
import { invalidState } from '../core/errors';
import { withManagedStorage, type StorageOwner } from './managed-storage';

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
/** Nearest attempt first; each attempt owns its objects so late writes cannot replace a successor. */
export async function checkpointAttemptIds(env:Env,jobId:string):Promise<string[]> {
  const rows=await env.DB.prepare("WITH RECURSIVE chain(id,depth) AS (SELECT ?1,0 UNION ALL SELECT l.parent_job_id,chain.depth+1 FROM admin_ai_retry_links l JOIN chain ON l.retry_job_id=chain.id WHERE chain.depth<128) SELECT id FROM chain ORDER BY depth").bind(jobId).all<{id:string}>();
  return rows.results.map(row=>row.id);
}
export async function allowsUncertainCheckpointRetry(env:Env,jobId?:string):Promise<boolean> {
  if(!jobId)return false;
  const job=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1').bind(jobId).first<{input_json:string}>();
  return !!job && JSON.parse(job.input_json).allowUncertainCheckpointRetry===true;
}
/** Manual permission applies only to the previously failed dispatch, never a future one. */
export async function clearUncertainCheckpointRetry(env:Env,jobId?:string):Promise<void> {
  if(!jobId)return;
  await env.DB.prepare("UPDATE jobs SET input_json=json_set(input_json,'$.allowUncertainCheckpointRetry',json('false')) WHERE id=?1 AND json_extract(input_json,'$.allowUncertainCheckpointRetry')=1").bind(jobId).run();
}
export async function checkpointFingerprint(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Encrypt every response, including non-private calls; bind each chunk to its key and index. */
export async function saveResponseCheckpoint(env:Env,key:string,value:unknown,options:{mutable?:boolean;owner?:StorageOwner}={}):Promise<void> {
  const envelope=await sealChunkedEnvelope('encrypted-response-v1','key',key,value,checkpointSecret(env));
  const targetEnv=options.owner?withManagedStorage(env,options.owner):env;
  await targetEnv.FILES.put(key,JSON.stringify(envelope),{httpMetadata:{contentType:'application/json'},...(options.mutable?{}:{onlyIf:{etagDoesNotMatch:'*'}})});
}
export async function loadResponseCheckpoint<T>(env:Env,key:string):Promise<T|null> {
  const stored=await env.FILES.get(key);if(!stored)return null;
  const envelope=await stored.json<{format:string;chunks:string[]}>();
  return unsealChunkedEnvelope<T>(
    envelope,
    'encrypted-response-v1',
    'key',
    key,
    checkpointSecret(env),
    { invalidFormat: '响应检查点格式无效', mismatch: '响应检查点内容不匹配' },
  );
}
