import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, env } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { createFileInit, storeFileContent } from '../src/services/files';
import { beginMultipart, completeMultipart, putMultipartPart } from '../src/services/file-multipart';
import { gcOrphanObjects } from '../src/services/gc';
import { sha256Hex } from '../src/core/db';
import { LIMITS } from '../src/core/limits';
import type { Env } from '../src/env';

const bytes=(text:string)=>new TextEncoder().encode(text);
function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return {promise,open};}
async function fixture(name='file.txt'){
  const user=await seedUser(),projectId=await seedProject(user.userId);
  const {fileId}=await createFileInit(env,{projectId,uploaderUserId:user.userId,fileName:name});
  return {user,projectId,fileId,actorId:user.userId};
}
function heldStorage(entered:ReturnType<typeof gate>,release:ReturnType<typeof gate>,keys:string[]):Env {
  return {...env,FILES:{put:async(key:string,body:Uint8Array)=>{keys.push(key);entered.open();await release.promise;return env.FILES.put(key,body);}}} as unknown as Env;
}
describe('upload identity and immutable attempts',()=>{
  it('rejects peer/contributor/resource-manager completion while preserving member initialization',async()=>{
    const f=await fixture(),peer=await seedUser();
    await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at,permissions_json) VALUES(?1,?2,?3,'member',?4,?5)").bind(crypto.randomUUID(),f.projectId,peer.userId,new Date().toISOString(),JSON.stringify({resourceManage:true})).run();
    await env.DB.prepare('INSERT INTO file_contributors(file_id,user_id,display_name) VALUES(?1,?2,?3)').bind(f.fileId,peer.userId,'Peer').run();
    const response=await SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/files/${f.fileId}/content`,{method:'PUT',headers:{cookie:authCookie(peer.token)},body:bytes('replacement')});
    expect(response.status).toBe(404);
    await expect(storeFileContent(env,{...f,actorId:peer.userId,bytes:bytes('replacement')})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await env.FILES.list()).objects).toHaveLength(0);
    const own=await createFileInit(env,{projectId:f.projectId,uploaderUserId:peer.userId,fileName:'own.txt',contributorIds:[f.actorId,peer.userId]});
    await storeFileContent(env,{projectId:f.projectId,fileId:own.fileId,actorId:peer.userId,bytes:bytes('own')});
  });
  it.each(['valid','invalid'] as const)('a late %s attempt cannot replace published bytes',async kind=>{
    const f=await fixture('file.pdf'),entered=gate(),release=gate(),keys:string[]=[];
    const late=storeFileContent(heldStorage(entered,release,keys),{...f,bytes:bytes(kind==='valid'?'%PDF-loser':'bad header')});
    const rejected=expect(late).rejects.toMatchObject({code:'INVALID_STATE'});await entered.promise;
    const winner=bytes('%PDF-winner');await storeFileContent(env,{...f,bytes:winner});release.open();await rejected;
    const row=await env.DB.prepare('SELECT status,r2_key,size_bytes,sha256 FROM files WHERE id=?1').bind(f.fileId).first<{status:string;r2_key:string;size_bytes:number;sha256:string}>();
    expect(row).toMatchObject({status:'available',size_bytes:winner.length,sha256:await sha256Hex(winner)});
    expect(row!.r2_key).not.toBe(keys[0]);expect(await (await env.FILES.get(row!.r2_key))!.arrayBuffer()).toEqual(winner.buffer);
    const collected=await gcOrphanObjects(env,new Date(Date.now()+86400_000).toISOString(),{graceDays:0});
    expect(collected.deleted).toContain(keys[0]);expect(collected.deleted).not.toContain(row!.r2_key);
  });
  it('a late valid attempt cannot overwrite the winning quarantine',async()=>{
    const f=await fixture('file.pdf'),entered=gate(),release=gate(),keys:string[]=[];
    const late=storeFileContent(heldStorage(entered,release,keys),{...f,bytes:bytes('%PDF-loser')});
    const rejected=expect(late).rejects.toMatchObject({code:'INVALID_STATE'});await entered.promise;
    await expect(storeFileContent(env,{...f,bytes:bytes('quarantine')})).rejects.toMatchObject({code:'UNSUPPORTED_MEDIA_TYPE'});
    release.open();await rejected;
    const row=await env.DB.prepare('SELECT status,r2_key FROM files WHERE id=?1').bind(f.fileId).first<{status:string;r2_key:string}>();
    expect(row!.status).toBe('quarantined');expect(await (await env.FILES.get(row!.r2_key))!.text()).toBe('quarantine');
  });
  it('a late quick upload cannot replace a completed multipart object',async()=>{
    const f=await fixture(),entered=gate(),release=gate(),keys:string[]=[];
    const late=storeFileContent(heldStorage(entered,release,keys),{...f,bytes:bytes('late quick')});
    const rejected=expect(late).rejects.toMatchObject({code:'INVALID_STATE'});await entered.promise;
    const session=await beginMultipart(env,f.projectId,f.fileId,f.actorId,9);
    await putMultipartPart(env,f.projectId,f.fileId,f.actorId,session.sessionId,1,new Blob(['multipart']).stream(),9);
    await completeMultipart(env,f.projectId,f.fileId,f.actorId,session.sessionId);
    release.open();await rejected;
    const row=await env.DB.prepare('SELECT r2_key FROM files WHERE id=?1').bind(f.fileId).first<{r2_key:string}>();
    expect(row!.r2_key).not.toBe(keys[0]);expect(await (await env.FILES.get(row!.r2_key))!.text()).toBe('multipart');
  });
  it.each(['file.txt','file.pdf'])('does not publish %s after membership revocation during storage',async name=>{
    const f=await fixture(name),entered=gate(),release=gate(),keys:string[]=[];
    const late=storeFileContent(heldStorage(entered,release,keys),{...f,bytes:bytes('content')});
    const rejected=expect(late).rejects.toMatchObject({code:'INVALID_STATE'});await entered.promise;
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId,f.actorId).run();release.open();await rejected;
    expect(await env.DB.prepare('SELECT status FROM files WHERE id=?1').bind(f.fileId).first()).toEqual({status:'pending'});
    expect(await env.DB.prepare('SELECT count(*) n FROM jobs WHERE project_id=?1').bind(f.projectId).first()).toEqual({n:0});
  });
  it('enforces the media total-size limit before multipart allocation and again at completion',async()=>{
    const f=await fixture('video.mp4');
    await expect(beginMultipart(env,f.projectId,f.fileId,f.actorId,LIMITS.maxMediaBytes+1)).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
    expect(await env.DB.prepare('SELECT count(*) n FROM file_upload_sessions WHERE file_id=?1').bind(f.fileId).first()).toEqual({n:0});
    const session=await beginMultipart(env,f.projectId,f.fileId,f.actorId,16);
    const row=await env.DB.prepare('SELECT r2_key FROM file_upload_sessions WHERE id=?1').bind(session.sessionId).first<{r2_key:string}>();
    await env.DB.prepare('UPDATE file_upload_sessions SET size_bytes=?2,part_bytes=?2 WHERE id=?1').bind(session.sessionId,LIMITS.maxMediaBytes+1).run();
    await env.DB.prepare('INSERT INTO file_upload_parts(session_id,part_number,etag,size_bytes) VALUES(?1,1,?2,?3)').bind(session.sessionId,'fake',LIMITS.maxMediaBytes+1).run();
    const target={...env,FILES:{head:async()=>({size:LIMITS.maxMediaBytes+1})}} as unknown as Env;
    await expect(completeMultipart(target,f.projectId,f.fileId,f.actorId,session.sessionId)).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
    expect(await env.DB.prepare('SELECT status,r2_key FROM files WHERE id=?1').bind(f.fileId).first()).toEqual({status:'quarantined',r2_key:row!.r2_key});
  });
});
