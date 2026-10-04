import { SELF } from 'cloudflare:test';
import { describe,it,expect } from 'vitest';
import { env,BASE } from './helpers/env';
import { seedUser,seedProject,authCookie } from './helpers/seed';
import type { Env } from '../src/env';
import { beginMultipart,putMultipartPart,completeMultipart,abortMultipart,multipartStatus } from '../src/services/file-multipart';
async function fixture(size=3) {
 const owner=await seedUser(),project=await seedProject(owner.userId);
 const res=await SELF.fetch(`${BASE}/api/v1/projects/${project}/files`,{method:'POST',headers:{cookie:authCookie(owner.token),'content-type':'application/json'},body:JSON.stringify({fileName:'资料.txt'})});
 const file=(await res.json() as {data:{fileId:string}}).data.fileId;
 const session=await beginMultipart(env,project,file,owner.userId,size);
 return {project,file,user:owner.userId,id:session.sessionId};
}
function stream(text:string){return new Blob([text]).stream();}
async function upload(f:Awaited<ReturnType<typeof fixture>>,text='abc',target=env){return putMultipartPart(target,f.project,f.file,f.user,f.id,1,stream(text),new TextEncoder().encode(text).length);}
function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return {promise,open};}
function wrappedFiles(overrides:Record<string,unknown>):Env {
 return {...env,FILES:{head:env.FILES.head.bind(env.FILES),get:env.FILES.get.bind(env.FILES),delete:env.FILES.delete.bind(env.FILES),resumeMultipartUpload:env.FILES.resumeMultipartUpload.bind(env.FILES),...overrides}} as unknown as Env;
}
describe('multipart lifetime and concurrency',()=>{
 it('recovers concurrent create using one winning session and distinct temporary keys',async()=>{
  const f=await fixture();await abortMultipart(env,f.project,f.file,f.user,f.id);
  const sessions=await Promise.all([beginMultipart(env,f.project,f.file,f.user,3),beginMultipart(env,f.project,f.file,f.user,3)]);
  expect(sessions[0].sessionId).toBe(sessions[1].sessionId);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM file_upload_sessions WHERE file_id=?1 AND status='uploading'").bind(f.file).first<{n:number}>())?.n).toBe(1);
 });
 it('uses a different key after an aborted upload even when the old complete object remains',async()=>{
  const f=await fixture();const part=await upload(f,'old');
  const old=await env.DB.prepare('SELECT r2_key,upload_id FROM file_upload_sessions WHERE id=?1').bind(f.id).first<{r2_key:string;upload_id:string}>();
  await env.FILES.resumeMultipartUpload(old!.r2_key,old!.upload_id).complete([part]);
  await env.DB.prepare("UPDATE file_upload_sessions SET status='aborted' WHERE id=?1").bind(f.id).run();
  const next=await beginMultipart(env,f.project,f.file,f.user,3);const current={...f,id:next.sessionId};await upload(current,'new');await completeMultipart(env,f.project,f.file,f.user,current.id);
  const file=await env.DB.prepare('SELECT r2_key FROM files WHERE id=?1').bind(f.file).first<{r2_key:string}>();
  expect(file!.r2_key).not.toBe(old!.r2_key);expect(await (await env.FILES.get(file!.r2_key))!.text()).toBe('new');
 });
 it('completion CAS excludes cancellation, new parts and another completion',async()=>{
  const f=await fixture();await upload(f);const entered=gate(),release=gate();
  const target=wrappedFiles({head:async(key:string)=>{entered.open();await release.promise;return env.FILES.head(key);}});
  const completing=completeMultipart(target,f.project,f.file,f.user,f.id);await entered.promise;
  await expect(abortMultipart(env,f.project,f.file,f.user,f.id)).rejects.toMatchObject({code:'INVALID_STATE'});
  await expect(upload(f)).rejects.toMatchObject({code:'INVALID_STATE'});
  await expect(completeMultipart(env,f.project,f.file,f.user,f.id)).rejects.toMatchObject({code:'INVALID_STATE'});
  release.open();expect(await completing).toEqual({fileId:f.file,status:'available'});
  expect((await multipartStatus(env,f.project,f.file,f.user,f.id)).status).toBe('complete');
 });
 it('reconciles an object completed before a request crashed',async()=>{
  const f=await fixture();const part=await upload(f);
  const s=await env.DB.prepare('SELECT r2_key,upload_id FROM file_upload_sessions WHERE id=?1').bind(f.id).first<{r2_key:string;upload_id:string}>();
  await env.FILES.resumeMultipartUpload(s!.r2_key,s!.upload_id).complete([part]);
  await env.DB.prepare("UPDATE file_upload_sessions SET status='completing' WHERE id=?1").bind(f.id).run();
  expect(await completeMultipart(env,f.project,f.file,f.user,f.id)).toEqual({fileId:f.file,status:'available'});
  expect(await completeMultipart(env,f.project,f.file,f.user,f.id)).toEqual({fileId:f.file,status:'available'});
 });
 it('reconciles prior non-atomic available-file publication',async()=>{
  const f=await fixture();const s=await env.DB.prepare('SELECT r2_key FROM file_upload_sessions WHERE id=?1').bind(f.id).first<{r2_key:string}>();
  await env.DB.prepare("UPDATE files SET status='available',r2_key=?2 WHERE id=?1").bind(f.file,s!.r2_key).run();
  await env.DB.prepare("UPDATE file_upload_sessions SET status='completing' WHERE id=?1").bind(f.id).run();
  await completeMultipart(env,f.project,f.file,f.user,f.id);expect((await multipartStatus(env,f.project,f.file,f.user,f.id)).status).toBe('complete');
 });
 it('excludes concurrent same-part writes with a lease',async()=>{
  const f=await fixture(),entered=gate(),release=gate();
  const target=wrappedFiles({resumeMultipartUpload:(key:string,id:string)=>{const original=env.FILES.resumeMultipartUpload(key,id);return {uploadPart:async(n:number,b:ReadableStream)=>{entered.open();await release.promise;return original.uploadPart(n,b);}};}});
  const first=upload(f,'abc',target);await entered.promise;await expect(upload(f)).rejects.toMatchObject({code:'INVALID_STATE'});release.open();expect((await first).partNumber).toBe(1);
 });
 it('does not publish part metadata when project membership is removed during transfer',async()=>{
  const f=await fixture();const target=wrappedFiles({resumeMultipartUpload:(key:string,id:string)=>{const original=env.FILES.resumeMultipartUpload(key,id);return {uploadPart:async(n:number,b:ReadableStream)=>{const p=await original.uploadPart(n,b);await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.project,f.user).run();return p;}};}});
  await expect(upload(f,'abc',target)).rejects.toMatchObject({code:'INVALID_STATE'});
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM file_upload_parts WHERE session_id=?1').bind(f.id).first()).toEqual({n:0});
 });
 it('retains a pending file when deletion happens during completion',async()=>{
  const f=await fixture();await upload(f);
  const target=wrappedFiles({head:async(key:string)=>{await env.DB.prepare('UPDATE files SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(f.file,new Date().toISOString()).run();return env.FILES.head(key);}});
  await expect(completeMultipart(target,f.project,f.file,f.user,f.id)).rejects.toThrow();
  expect(await env.DB.prepare('SELECT status FROM files WHERE id=?1').bind(f.file).first()).toEqual({status:'pending'});
 });
 it('rejects actual transport/platform constraints before creating R2 uploads',async()=>{
  const f=await fixture();await abortMultipart(env,f.project,f.file,f.user,f.id);
  await expect(beginMultipart(env,f.project,f.file,f.user,5*1024**4+1)).rejects.toMatchObject({code:'FILE_TOO_LARGE',details:{platform:'R2'}});
  await expect(beginMultipart(env,f.project,f.file,f.user,2*1024**4)).rejects.toMatchObject({code:'FILE_TOO_LARGE',details:{requestMaxBytes:100000000,maxParts:10000}});
 });
 it('enforces actual streamed byte count rather than trusting x-part-size',async()=>{
  const f=await fixture();await expect(putMultipartPart(env,f.project,f.file,f.user,f.id,1,stream('long'),3)).rejects.toThrow();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM file_upload_parts WHERE session_id=?1').bind(f.id).first()).toEqual({n:0});
 });
 it('returns to uploading when storage completion fails before an object is published',async()=>{
  const f=await fixture();await upload(f);
  const target=wrappedFiles({resumeMultipartUpload:()=>({complete:async()=>{throw new TypeError('storage temporary failure');}})});
  await expect(completeMultipart(target,f.project,f.file,f.user,f.id)).rejects.toThrow('storage temporary failure');
  expect((await multipartStatus(env,f.project,f.file,f.user,f.id)).status).toBe('uploading');
  await upload(f,'def');await completeMultipart(env,f.project,f.file,f.user,f.id);
  const row=await env.DB.prepare('SELECT r2_key FROM files WHERE id=?1').bind(f.file).first<{r2_key:string}>();
  expect(await (await env.FILES.get(row!.r2_key))!.text()).toBe('def');
 });

});
