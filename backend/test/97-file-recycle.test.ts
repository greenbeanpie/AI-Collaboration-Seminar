import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { handleScheduled } from '../src/cron';
import { storeFileContent } from '../src/services/files';

const headers=(token:string)=>({cookie:authCookie(token),'content-type':'application/json'});
const request=(token:string,pid:string,path:string,method='GET',body?:unknown)=>SELF.fetch(`${BASE}/api/v1/projects/${pid}${path}`,{method,headers:headers(token),...(body===undefined?{}:{body:JSON.stringify(body)})});
async function init(token:string,pid:string,name='pending.txt') {
  const r=await request(token,pid,'/files','POST',{fileName:name});expect(r.status).toBe(201);
  return (await r.json() as {data:{fileId:string}}).data.fileId;
}
async function member(pid:string,userId:string) {await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),pid,userId,nowIso()).run();}
async function list(token:string,pid:string,deleted=false) {const r=await request(token,pid,`/files?deleted=${deleted}`);expect(r.status).toBe(200);return(await r.json() as {data:{items:Array<{fileId:string;status:string;lifecycleVersion:number;canDelete:boolean}>}}).data.items;}
async function change(token:string,pid:string,id:string,version:number,restore=false) {return request(token,pid,`/files/${id}${restore?'/restore':''}`,restore?'POST':'DELETE',{expectedLifecycleVersion:version});}

describe('recoverable project file lifecycle',()=>{
  it('lists unfinished uploads and soft deletes/restores with CAS, no automatic AI',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);const id=await init(owner.token,pid);
    expect(await list(owner.token,pid)).toEqual([expect.objectContaining({fileId:id,status:'pending',lifecycleVersion:1,canDelete:true})]);
    expect((await change(owner.token,pid,id,1)).status).toBe(200);
    expect(await list(owner.token,pid)).toEqual([]);expect(await list(owner.token,pid,true)).toEqual([expect.objectContaining({fileId:id,lifecycleVersion:2})]);
    expect((await request(owner.token,pid,`/files/${id}/content`,'PUT',{})).status).toBe(404);
    expect((await change(owner.token,pid,id,1)).status).toBe(409);
    expect((await change(owner.token,pid,id,2,true)).status).toBe(200);
    expect((await change(owner.token,pid,id,2,true)).status).toBe(409);
    expect((await list(owner.token,pid))[0]?.lifecycleVersion).toBe(3);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?1').bind(pid).first<{n:number}>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM files WHERE id=?1').bind(id).first<{n:number}>())?.n).toBe(1);
  });
  it('enforces owner/uploader, revoked membership and cross-project boundaries server-side',async()=>{
    const owner=await seedUser();const uploader=await seedUser();const peer=await seedUser();const outsider=await seedUser();
    const pid=await seedProject(owner.userId);await member(pid,uploader.userId);await member(pid,peer.userId);
    const id=await init(uploader.token,pid);
    await env.DB.prepare("UPDATE auth_accounts SET account_role='admin',is_admin=1 WHERE user_id=?1").bind(peer.userId).run();
    expect((await list(peer.token,pid))[0]?.canDelete).toBe(false);
    expect((await change(peer.token,pid,id,1)).status).toBe(403);
    expect((await change(outsider.token,pid,id,1)).status).toBe(403);
    expect((await change(owner.token,await seedProject(owner.userId),id,1)).status).toBe(404);
    expect((await change(uploader.token,pid,id,1)).status).toBe(200);
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(pid,uploader.userId).run();
    expect((await change(uploader.token,pid,id,2,true)).status).toBe(403);
    expect((await change(owner.token,pid,id,2,true)).status).toBe(200);
  });
  it('retains bytes/history, cancels parse/OCR/summary and outbox; restore cannot revive them',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);const id=await init(owner.token,pid,'original.txt');
    await storeFileContent(env,{projectId:pid,fileId:id,bytes:new TextEncoder().encode('历史来源正文')});
    const sourceResp=await request(owner.token,pid,'/sources','POST',{kind:'file',fileId:id,title:'已导入文件'});expect(sourceResp.status).toBe(201);
    const source=(await sourceResp.json() as {data:{sourceId:string;sourceVersionId:string}}).data;
    const now=nowIso();const jobs=[newId(),newId(),newId()];
    await env.DB.batch(jobs.flatMap((jobId,i)=>[
      env.DB.prepare('INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,0,?6,?7,?7)').bind(jobId,pid,i===1?'ocr_pages':'parse_source',['queued','running','waiting_input'][i],JSON.stringify({sourceId:source.sourceId,sourceVersionId:source.sourceVersionId,sourceLifecycleVersion:1,operation:i===2?'source.summary':undefined}),owner.userId,now),
      env.DB.prepare("INSERT INTO job_outbox(id,job_id,status,available_at,attempts,created_at,updated_at) VALUES(?1,?2,'pending',?3,0,?3,?3)").bind(newId(),jobId,now),
    ]));
    await env.DB.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,requirements_status,summary_status,summary_job_id,summary_revision,summary_json,updated_at) VALUES(?1,?2,'processing','processing','running',?3,1,'{\"history\":true}',?4)").bind(source.sourceVersionId,pid,jobs[2],now).run();
    const file=await env.DB.prepare('SELECT r2_key FROM files WHERE id=?1').bind(id).first<{r2_key:string}>();
    expect((await change(owner.token,pid,id,1)).status).toBe(200);
    expect((await env.FILES.get(file!.r2_key))?.text()).resolves.toBe('历史来源正文');
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE project_id=?1').bind(pid).all<{status:string}>()).results.map(j=>j.status)).toEqual(['cancelled','cancelled','cancelled']);
    expect((await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id IN (?1,?2,?3)').bind(...jobs).all<{status:string}>()).results.every(j=>j.status==='failed')).toBe(true);
    expect((await request(owner.token,pid,`/sources/${source.sourceId}/versions/${source.sourceVersionId}`)).status).toBe(404);
    expect((await request(owner.token,pid,`/sources/${source.sourceId}/parse`,'POST',{})).status).toBe(404);
    expect((await request(owner.token,pid,`/files/${id}/content`)).status).toBe(404);
    expect((await change(owner.token,pid,id,2,true)).status).toBe(200);
    const active=await request(owner.token,pid,'/sources');expect((await active.json() as {data:{items:unknown[]}}).data.items).toHaveLength(1);
    expect((await env.DB.prepare('SELECT lifecycle_version FROM sources WHERE id=?1').bind(source.sourceId).first<{lifecycle_version:number}>())?.lifecycle_version).toBe(3);
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE project_id=?1').bind(pid).all<{status:string}>()).results.every(j=>j.status==='cancelled')).toBe(true);
    expect((await env.DB.prepare('SELECT summary_status,summary_json FROM source_processing WHERE source_version_id=?1').bind(source.sourceVersionId).first<{summary_status:string;summary_json:string}>())).toEqual({summary_status:'cancelled',summary_json:'{"history":true}'});
    expect((await request(owner.token,pid,`/files/${id}/content`)).status).toBe(200);
  });
  it('keeps quarantined original objects safe from existing GC after recycle and restore',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);const id=await init(owner.token,pid,'invalid.pdf');
    await expect(storeFileContent(env,{projectId:pid,fileId:id,bytes:new TextEncoder().encode('invalid but retained')})).rejects.toThrow();
    await env.DB.prepare("UPDATE files SET gc_after='2000-01-01T00:00:00Z' WHERE id=?1").bind(id).run();
    const file=await env.DB.prepare('SELECT r2_key FROM files WHERE id=?1').bind(id).first<{r2_key:string}>();
    const deletion=vi.spyOn(env.FILES,'delete');
    expect((await change(owner.token,pid,id,1)).status).toBe(200);
    await handleScheduled(env);expect(deletion).not.toHaveBeenCalledWith(file!.r2_key);expect(await env.FILES.get(file!.r2_key)).not.toBeNull();
    expect((await change(owner.token,pid,id,2,true)).status).toBe(200);await handleScheduled(env);expect(await env.FILES.get(file!.r2_key)).not.toBeNull();
    deletion.mockRestore();
  });
  it('recycles and restores paste/web by creator with version check and preserves source records',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);
    const r=await request(owner.token,pid,'/sources','POST',{kind:'paste',text:'保留正文',title:'粘贴材料'});expect(r.status).toBe(201);
    const data=(await r.json() as {data:{sourceId:string}}).data;
    expect((await request(owner.token,pid,`/sources/${data.sourceId}`,'DELETE',{expectedLifecycleVersion:1})).status).toBe(200);
    const trash=await request(owner.token,pid,'/sources?deleted=true');expect((await trash.json() as {data:{items:unknown[]}}).data.items).toHaveLength(1);
    expect((await request(owner.token,pid,`/sources/${data.sourceId}/restore`,'POST',{expectedLifecycleVersion:2})).status).toBe(200);
  });
  it('restores a dependent source once all recycled original and page image files are restored',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);const original=await init(owner.token,pid);
    await storeFileContent(env,{projectId:pid,fileId:original,bytes:new TextEncoder().encode('原文')});
    const r=await request(owner.token,pid,'/sources','POST',{kind:'file',fileId:original});const source=(await r.json() as {data:{sourceId:string;sourceVersionId:string}}).data;
    const image=await init(owner.token,pid,'page.png');
    await env.DB.prepare("UPDATE files SET status='available' WHERE id=?1").bind(image).run();
    await env.DB.prepare("INSERT INTO source_pages(id,source_version_id,project_id,page_number,image_file_id,image_status,updated_at) VALUES(?1,?2,?3,1,?4,'uploaded',?5)").bind(newId(),source.sourceVersionId,pid,image,nowIso()).run();
    expect((await change(owner.token,pid,original,1)).status).toBe(200);
    expect((await change(owner.token,pid,image,1)).status).toBe(200);
    expect((await change(owner.token,pid,original,2,true)).status).toBe(200);
    expect((await env.DB.prepare('SELECT deleted_at FROM sources WHERE id=?1').bind(source.sourceId).first<{deleted_at:string|null}>())?.deleted_at).not.toBeNull();
    expect((await change(owner.token,pid,image,2,true)).status).toBe(200);
    expect((await env.DB.prepare('SELECT deleted_at,lifecycle_version FROM sources WHERE id=?1').bind(source.sourceId).first<{deleted_at:string|null;lifecycle_version:number}>())).toEqual({deleted_at:null,lifecycle_version:3});
  });
  it('concurrent repeat deletion changes one lifecycle only and download is never cached',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);const id=await init(owner.token,pid);
    await storeFileContent(env,{projectId:pid,fileId:id,bytes:new TextEncoder().encode('retained')});
    const read=await request(owner.token,pid,`/files/${id}/content`);expect(read.headers.get('cache-control')).toBe('no-store');
    const responses=await Promise.all([change(owner.token,pid,id,1),change(owner.token,pid,id,1)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await env.DB.prepare('SELECT lifecycle_version FROM files WHERE id=?1').bind(id).first<{lifecycle_version:number}>())?.lifecycle_version).toBe(2);
  });

  it('ignores an in-flight upload completing after delete/restore without overwriting fresh bytes',async()=>{
    const owner=await seedUser();const pid=await seedProject(owner.userId);const id=await init(owner.token,pid);
    let release!:()=>void;let started!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});const began=new Promise<void>(resolve=>{started=resolve;});
    const originalPut=env.FILES.put.bind(env.FILES);
    const put=vi.spyOn(env.FILES,'put').mockImplementation(async(...args:Parameters<typeof env.FILES.put>)=>{
      if(args[0].includes('.l1.')){started();await held;}
      return originalPut(...args);
    });
    const old=storeFileContent(env,{projectId:pid,fileId:id,bytes:new TextEncoder().encode('old upload')});
    const ignored=expect(old).rejects.toThrow('文件生命周期已变化');await began;
    expect((await change(owner.token,pid,id,1)).status).toBe(200);expect((await change(owner.token,pid,id,2,true)).status).toBe(200);
    await storeFileContent(env,{projectId:pid,fileId:id,bytes:new TextEncoder().encode('fresh upload')});release();await ignored;put.mockRestore();
    const file=await env.DB.prepare('SELECT status,r2_key,lifecycle_version FROM files WHERE id=?1').bind(id).first<{status:string;r2_key:string;lifecycle_version:number}>();
    expect(file?.status).toBe('available');expect(file?.lifecycle_version).toBe(3);expect(file?.r2_key).toContain('.l3.');expect(await(await env.FILES.get(file!.r2_key))?.text()).toBe('fresh upload');
  });

});
