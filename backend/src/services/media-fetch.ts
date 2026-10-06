import { purposeSecret } from '../ai/secrets';
import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from '../core/db';
import { invalidState } from '../core/errors';
import { sourceLifecycleGuard } from './source-lifecycle';

export const MEDIA_GRANT_SECONDS=900;
interface MediaGrantFile { state_id:string; r2_key:string; mime:string; size_bytes:number; file_id:string; lifecycle:number; }

/** A grant is usable only while this exact MiMo request owns an active lease. */
async function grantFile(env:Env,jobId:string):Promise<MediaGrantFile|null> {
  return env.DB.prepare(`SELECT m.id state_id,f.r2_key,f.mime_detected mime,f.size_bytes,f.id file_id,s.lifecycle_version lifecycle
    FROM media_processing m JOIN jobs j ON j.id=m.job_id JOIN source_versions v ON v.id=m.source_version_id
    JOIN sources s ON s.id=v.source_id JOIN files f ON f.id=v.file_id
    WHERE j.id=?1 AND m.provider='mimo' AND m.stage='generating' AND m.lease_token IS NOT NULL AND m.lease_expires_at>?2
      AND j.status IN ('queued','running') AND j.project_id=v.project_id AND f.project_id=v.project_id
      AND ${sourceLifecycleGuard('v.id',"COALESCE(json_extract(j.input_json,'$.sourceLifecycleVersion'),1)")}
    UNION ALL
    SELECT m.id,f.r2_key,f.mime,f.size_bytes,f.id,0
    FROM media_processing m JOIN jobs j ON j.id=m.job_id JOIN creation_draft_files f ON f.id=m.draft_file_id
    JOIN project_creation_drafts d ON d.id=f.draft_id
    WHERE j.id=?1 AND m.provider='mimo' AND m.stage='generating' AND m.lease_token IS NOT NULL AND m.lease_expires_at>?2
      AND j.status IN ('queued','running') AND j.project_id IS NULL AND d.status='active' AND f.removed=0
      AND d.id=json_extract(j.input_json,'$.draftId') AND f.id=json_extract(j.input_json,'$.fileId')
      AND j.created_by=d.owner_id`).bind(jobId,new Date().toISOString()).first<MediaGrantFile>();
}
function grantMessage(jobId:string,file:MediaGrantFile,expires:string):string {
  return JSON.stringify(['mimo-media-v1',jobId,file.state_id,file.file_id,file.r2_key,file.mime,file.size_bytes,file.lifecycle,expires]);
}
export async function createMediaFetchUrl(env:Env,jobId:string):Promise<string> {
  const base=new URL(env.MEDIA_FETCH_BASE_URL??'https://invalid.local');
  if(!env.MEDIA_FETCH_BASE_URL||base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw invalidState('MiMo 文件读取地址必须配置为 HTTPS Origin');
  const file=await grantFile(env,jobId);if(!file)throw invalidState('MiMo 文件读取授权已失效');
  const expires=String(Math.floor(Date.now()/1000)+MEDIA_GRANT_SECONDS);
  const signature=await hmacSha256Hex(await purposeSecret(env, 'media-grant'),grantMessage(jobId,file,expires));
  const url=new URL('/api/v1/media-fetch/'+jobId,base);
  url.searchParams.set('v','2');url.searchParams.set('expires',expires);url.searchParams.set('signature',signature);
  return url.href;
}

function rangeOf(value:string,size:number):{offset:number;length:number}|null {
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||(!match[1]&&!match[2])||size<=0)return null;
  const first=match[1]?Number(match[1]):null,last=match[2]?Number(match[2]):null;
  if((first!==null&&!Number.isSafeInteger(first))||(last!==null&&!Number.isSafeInteger(last)))return null;
  if(first===null){if(!last||last<0)return null;const length=Math.min(last,size);return {offset:size-length,length};}
  if(first>=size||first<0||(last!==null&&last<first))return null;
  return {offset:first,length:Math.min(last??size-1,size-1)-first+1};
}

/** No session or arbitrary object key is accepted; the signed grant is the authority. */
export async function readMediaGrant(env:Env,request:Request,jobId:string):Promise<Response> {
  const headers=new Headers({'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  const denied=()=>new Response(null,{status:404,headers});
  if(!['GET','HEAD'].includes(request.method)||!/^[0-9a-f-]{36}$/i.test(jobId))return denied();
  const url=new URL(request.url),expires=url.searchParams.get('expires')??'',signature=url.searchParams.get('signature')??'';
  const now=Math.floor(Date.now()/1000),expiry=Number(expires);
  if(!/^\d{10}$/.test(expires)||!Number.isSafeInteger(expiry)||expiry<=now||expiry>now+MEDIA_GRANT_SECONDS||!/^[0-9a-f]{64}$/.test(signature))return denied();
  const file=await grantFile(env,jobId);if(!file)return denied();
  const version=url.searchParams.get('v');
  if(version!==null&&version!=='2')return denied();
  const grantSecret=version==='2'?await purposeSecret(env,'media-grant'):env.AUTH_SECRET;
  if(!await timingSafeEqual(signature,await hmacSha256Hex(grantSecret,grantMessage(jobId,file,expires))))return denied();
  const metadata=await env.FILES.head(file.r2_key);if(!metadata||metadata.size!==file.size_bytes)return denied();
  headers.set('content-type',file.mime);headers.set('accept-ranges','bytes');headers.set('etag',metadata.httpEtag);
  let range:{offset:number;length:number}|undefined;
  const rangeHeader=request.headers.get('range'),ifRange=request.headers.get('if-range');
  if(request.method==='GET'&&rangeHeader&&(!ifRange||ifRange===metadata.httpEtag)){
    const parsed=rangeOf(rangeHeader,metadata.size);
    if(!parsed){headers.set('content-range',`bytes */${metadata.size}`);return new Response(null,{status:416,headers});}
    range=parsed;headers.set('content-range',`bytes ${range.offset}-${range.offset+range.length-1}/${metadata.size}`);
  }
  headers.set('content-length',String(range?.length??metadata.size));
  if(request.method==='HEAD'){
    const current=await grantFile(env,jobId);
    if(!current||grantMessage(jobId,current,expires)!==grantMessage(jobId,file,expires))return denied();
    return new Response(null,{headers});
  }
  const object=await env.FILES.get(file.r2_key,{...(range?{range}:{}),onlyIf:{etagMatches:metadata.etag}});
  if(!object||!('body' in object))return denied();
  // Recheck after R2 I/O to close cancellation/deletion races before delivering bytes.
  const current=await grantFile(env,jobId);
  if(!current||grantMessage(jobId,current,expires)!==grantMessage(jobId,file,expires)){await object.body.cancel();return denied();}
  return new Response(object.body,{status:range?206:200,headers});
}
