import type {Env} from '../env';
import {newId,nowIso} from '../core/db';
import {AppError,invalidState,quotaExceeded,validationFailed} from '../core/errors';
import {loadResourcePolicy} from './resource-policy';

export interface StorageOwner {userId?:string|null;projectId?:string|null;category:'upload'|'system'}
type Reservation={id:string;object_key:string;bytes:number;user_id:string|null;project_id:string|null;category:'upload'|'system';kind:string;status:string;upload_id:string|null;expires_at:string};
const DAY=86400000;
const UUID=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const rawBuckets=new WeakMap<object,R2Bucket>();
export const rawStorage=(env:Pick<Env,'FILES'>):R2Bucket=>rawBuckets.get(env.FILES)??env.FILES;

/** Resolve server-owned key namespaces. Unattributable legacy objects still consume platform space. */
export async function storageOwner(env:Pick<Env,'DB'>,key:string):Promise<StorageOwner>{
 const s=key.split('/');
 let row:{user_id:string|null;project_id:string|null}|null=null;
 let category:StorageOwner['category']='system';
 if(UUID.test(s[0]??'')&&UUID.test((s[1]??'').split('.')[0]??'')){
  category='upload';row=await env.DB.prepare('SELECT uploader_user_id user_id,project_id FROM files WHERE id=?1').bind(s[1]!.split('.')[0]).first();
 }else if(s[0]==='creation-drafts'){
  category='upload';row=await env.DB.prepare('SELECT owner_id user_id,NULL project_id FROM project_creation_drafts WHERE id=?1').bind(s[1]).first();
 }else if(s[0]==='support-images'){
  category='upload';row=await env.DB.prepare('SELECT owner_id user_id,NULL project_id FROM support_tickets WHERE id=?1').bind(s[1]).first();
 }else if(s[0]==='sources'){
  category=s[2]==='paste.txt'?'upload':'system';row=await env.DB.prepare('SELECT s.created_by user_id,v.project_id FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.id=?1').bind(s[1]).first();
 }else if(s[0]==='ai-calls'){
  row=await env.DB.prepare('SELECT j.created_by user_id,c.project_id FROM ai_calls c LEFT JOIN jobs j ON j.id=c.job_id WHERE c.id=?1').bind(s[1]).first();
 }else if(s[0]==='agent-bridges'){
  row=await env.DB.prepare('SELECT requested_by user_id,project_id FROM agent_bridge_handoffs WHERE id=?1').bind(s[2]).first();
 }else if(s[0]==='ai'&&s[1]==='investigations'){
  row=await env.DB.prepare('SELECT requested_by user_id,project_id FROM ai_investigations WHERE id=?1').bind(s[2]!.split('.')[0]).first();
 }else if(s[0]==='ai'&&s[1]==='draft-investigations'){
  row=await env.DB.prepare('SELECT owner_id user_id,NULL project_id FROM project_creation_drafts WHERE preview_attempt_id=?1').bind(s[2]!.split('.')[0]).first();
 }
 if(!row&&category==='system')for(const part of s){const id=part.split('.')[0]!;if(!UUID.test(id))continue;row=await env.DB.prepare('SELECT created_by user_id,project_id FROM jobs WHERE id=?1').bind(id).first();if(row)break;}
 return {userId:row?.user_id??null,projectId:row?.project_id??null,category};
}

async function ready(env:Env){
 if(env.ENV_NAME==='local')await env.DB.prepare('UPDATE storage_inventory_state SET ready=1 WHERE id=1 AND ready=0').run();
 const state=await env.DB.prepare('SELECT ready,external_checked_at FROM storage_inventory_state WHERE id=1').first<{ready:number;external_checked_at:string|null}>();
 if(!state?.ready||env.ENV_NAME!=='local'&&(!state.external_checked_at||Date.now()-Date.parse(state.external_checked_at)>DAY))throw new AppError('QUOTA_EXCEEDED','存储盘点未完成或其他桶用量需要重新核查，已暂停新增存储',503,false,{storageInventoryRequired:true});
}
const total=(scope:string,id:string)=>`COALESCE((SELECT bytes FROM storage_counters WHERE scope='${scope}' AND scope_id=${id}),0)`;
export async function reserveStorage(env:Env,key:string,bytes:number,kind:'put'|'multipart'|'delete',owner?:StorageOwner):Promise<Reservation>{
 if(!Number.isSafeInteger(bytes)||bytes<0)throw validationFailed('存储长度无效');
 if(kind!=='delete')await ready(env);
 const identity=owner??await storageOwner(env,key),id=newId(),now=nowIso(),policy=await loadResourcePolicy(env);
 const result=await env.DB.prepare(`INSERT INTO storage_reservations(id,object_key,bytes,user_id,project_id,category,kind,status,expires_at,updated_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7,'reserved',?8,?9 FROM resource_policy WHERE id=1 AND version=?10
 AND NOT EXISTS(SELECT 1 FROM storage_reservations WHERE object_key=?2)
 AND (?7='delete' OR (
 ${total('platform',"'all'")}+?3<=MAX(0,json_extract(policy_json,'$.platformStorageBytes')-json_extract(policy_json,'$.externalStorageBytes'))
 AND (?6!='upload' OR ${total('platform',"'upload'")}+?3<=MIN(json_extract(policy_json,'$.uploadPoolBytes'),CAST(MAX(0,json_extract(policy_json,'$.platformStorageBytes')-json_extract(policy_json,'$.externalStorageBytes'))*0.8 AS INTEGER)))
 AND (?4 IS NULL OR ${total('user','?4')}+?3<=json_extract(policy_json,'$.userStorageBytes'))
 AND (?5 IS NULL OR ${total('project','?5')}+?3<=json_extract(policy_json,'$.projectStorageBytes'))))
 ON CONFLICT(object_key) DO NOTHING`).bind(id,key,bytes,identity.userId??null,identity.projectId??null,identity.category,kind,new Date(Date.now()+DAY).toISOString(),now,policy.version).run();
 if(!result.meta.changes){
  const busy=await env.DB.prepare('SELECT 1 FROM storage_reservations WHERE object_key=?1').bind(key).first();
  if(busy)throw invalidState('该对象正在写入或等待结果核对，请稍后重试');
  throw quotaExceeded('用户、项目或平台存储额度不足，已有内容保留',{storageQuota:true});
 }
 return {id,object_key:key,bytes,user_id:identity.userId??null,project_id:identity.projectId??null,category:identity.category,kind,status:'reserved',upload_id:null,expires_at:new Date(Date.now()+DAY).toISOString()};
}
async function release(env:Env,id:string){await env.DB.prepare('DELETE FROM storage_reservations WHERE id=?1').bind(id).run();}
async function uncertain(env:Env,id:string){await env.DB.prepare("UPDATE storage_reservations SET status='uncertain',updated_at=?2 WHERE id=?1").bind(id,nowIso()).run();}
async function commit(env:Env,r:Reservation,object:R2Object){
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO storage_objects(object_key,size_bytes,user_id,project_id,category,etag,updated_at)
   SELECT object_key,?2,user_id,project_id,category,?3,?4 FROM storage_reservations WHERE id=?1
   ON CONFLICT(object_key) DO UPDATE SET size_bytes=excluded.size_bytes,etag=excluded.etag,updated_at=excluded.updated_at`).bind(r.id,object.size,object.etag,nowIso()),
  env.DB.prepare('DELETE FROM storage_reservations WHERE id=?1 AND EXISTS(SELECT 1 FROM storage_objects WHERE object_key=?2 AND etag=?3)').bind(r.id,r.object_key,object.etag),
 ]);
 if(!result[0]?.meta.changes)throw invalidState('存储预占已变化，写入结果需核对');
}
function byteLength(value:Parameters<R2Bucket['put']>[1]):number{
 if(value===null)return 0;if(typeof value==='string')return new TextEncoder().encode(value).byteLength;
 if(value instanceof Blob)return value.size;if(value instanceof ArrayBuffer||ArrayBuffer.isView(value))return value.byteLength;
 throw validationFailed('流式写入必须使用带完整长度预占的分片上传');
}
/** All production fetch, queue, cron and Workflow environments use this adapter. */
export function withManagedStorage(env:Env,owner?:StorageOwner):Env{
 const raw=rawStorage(env);
 const bucket=new Proxy(raw,{
  get(target,property){
   if(property==='put')return async(key:string,value:Parameters<R2Bucket['put']>[1],options?:R2PutOptions)=>{
    const r=await reserveStorage(env,key,byteLength(value),'put',owner);
    try{
     const object=await raw.put(key,value,{...options,customMetadata:{...options?.customMetadata,storageClaim:r.id}});
     if(!object){await release(env,r.id);return null;}
     await commit(env,r,object);return object;
    }catch(error){await uncertain(env,r.id);throw error;}
   };
   if(property==='delete')return async(keys:string|string[])=>{
    for(const key of typeof keys==='string'?[keys]:keys){
     const reservation=await env.DB.prepare('SELECT * FROM storage_reservations WHERE object_key=?1').bind(key).first<Reservation>();
     // Multipart abort owns its existing reservation. Other in-flight objects cannot be deleted.
     if(reservation)throw invalidState('对象仍有上传或写入预占，不能并发删除');
     const r=await reserveStorage(env,key,0,'delete',owner);
     try{await raw.delete(key);await env.DB.batch([env.DB.prepare('DELETE FROM storage_objects WHERE object_key=?1').bind(key),env.DB.prepare('DELETE FROM storage_reservations WHERE id=?1').bind(r.id)]);}
     catch(error){await uncertain(env,r.id);throw error;}
    }
   };
   if(property==='createMultipartUpload')return async(key:string,options?:R2MultipartOptions)=>{
    const r=await env.DB.prepare("SELECT * FROM storage_reservations WHERE object_key=?1 AND kind='multipart' AND status='reserved' AND upload_id IS NULL").bind(key).first<Reservation>();
    if(!r)throw invalidState('分片上传缺少完整字节预占');
    try{const upload=await raw.createMultipartUpload(key,{...options,customMetadata:{...options?.customMetadata,storageClaim:r.id}});await env.DB.prepare('UPDATE storage_reservations SET upload_id=?2 WHERE id=?1').bind(r.id,upload.uploadId).run();return multipart(key,upload.uploadId);}
    catch(error){await uncertain(env,r.id);throw error;}
   };
   if(property==='resumeMultipartUpload')return multipart;
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }
 }) as R2Bucket;
 async function reservation(key:string,id:string){
  const r=await env.DB.prepare("SELECT * FROM storage_reservations WHERE object_key=?1 AND upload_id=?2 AND kind='multipart'").bind(key,id).first<Reservation>();
  if(!r)throw invalidState('分片上传预占不存在或已结束');return r;
 }
 function multipart(key:string,id:string):R2MultipartUpload{
  const upload=raw.resumeMultipartUpload(key,id);
  return {key,uploadId:id,
   uploadPart:async(part,value)=>{const r=await reservation(key,id);await ready(env);await env.DB.prepare('UPDATE storage_reservations SET expires_at=?2,updated_at=?3 WHERE id=?1').bind(r.id,new Date(Date.now()+DAY).toISOString(),nowIso()).run();return upload.uploadPart(part,value);},
   complete:async(parts)=>{const r=await reservation(key,id);try{const o=await upload.complete(parts);if(o.size>r.bytes)throw invalidState('对象超出预占长度，需核对');await commit(env,r,o);return o;}catch(error){await uncertain(env,r.id);throw error;}},
   abort:async()=>{const r=await reservation(key,id);try{const object=await raw.head(key);if(object)await raw.delete(key);else await upload.abort();await env.DB.batch([env.DB.prepare('DELETE FROM storage_objects WHERE object_key=?1').bind(key),env.DB.prepare('DELETE FROM storage_reservations WHERE id=?1').bind(r.id)]);}catch(error){await uncertain(env,r.id);throw error;}},
  };
 }
 rawBuckets.set(bucket,raw);return {...env,FILES:bucket};
}

/** Confirm uncertain writes, never expire an unknown upload merely by releasing quota. */
export async function reconcileStorage(env:Env,limit=25){
 const raw=rawStorage(env),now=nowIso();
 const rows=await env.DB.prepare("SELECT * FROM storage_reservations WHERE status='uncertain' OR expires_at<=?1 ORDER BY updated_at,id LIMIT ?2").bind(now,limit).all<Reservation>();
 for(const r of rows.results){
  const object=await raw.head(r.object_key);
  if(r.kind==='delete'){if(!object){await env.DB.batch([env.DB.prepare('DELETE FROM storage_objects WHERE object_key=?1').bind(r.object_key),env.DB.prepare('DELETE FROM storage_reservations WHERE id=?1').bind(r.id)]);}continue;}
  if(object?.customMetadata?.storageClaim===r.id){await commit(env,r,object);continue;}
  if(r.kind==='multipart'&&r.upload_id){
   const live=await env.DB.prepare(`SELECT 1 FROM file_upload_part_leases p JOIN file_upload_sessions s ON s.id=p.session_id WHERE s.upload_id=?1 AND p.expires_at>?2
    UNION ALL SELECT 1 FROM draft_document_part_leases p JOIN draft_document_uploads u ON u.file_id=p.file_id WHERE u.upload_id=?1 AND p.expires_at>?2
    UNION ALL SELECT 1 FROM file_upload_sessions WHERE upload_id=?1 AND operation_expires_at>?2
    UNION ALL SELECT 1 FROM draft_document_uploads WHERE upload_id=?1 AND operation_expires_at>?2`).bind(r.upload_id,now).first();
   if(live||r.expires_at>now)continue;
   await raw.resumeMultipartUpload(r.object_key,r.upload_id).abort();
   await env.DB.batch([env.DB.prepare("UPDATE file_upload_sessions SET status='aborted',operation_token=NULL,operation_expires_at=NULL WHERE upload_id=?1 AND status!='complete'").bind(r.upload_id),env.DB.prepare("UPDATE draft_document_uploads SET status='cancelled',operation_token=NULL,operation_expires_at=NULL WHERE upload_id=?1 AND status!='complete'").bind(r.upload_id)]);
   await release(env,r.id);
  }
  // HTTP writes with ambiguous completion retain quota until an operator verifies absence.
 }
}
