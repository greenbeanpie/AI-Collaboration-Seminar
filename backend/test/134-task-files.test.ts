import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { saveTaskFile } from '../src/services/task-files';
import type { Env } from '../src/env';

async function fixture() {
  const owner=await seedUser(),executor=await seedUser(),other=await seedUser();
  const projectId=await seedProject(owner.userId),taskId=crypto.randomUUID(),now=new Date().toISOString();
  for(const member of [executor,other]) await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(crypto.randomUUID(),projectId,member.userId,now).run();
  await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,assignee_id,created_by,created_at,updated_at) VALUES(?1,?2,'文件任务','','todo',?3,?4,?5,?5)").bind(taskId,projectId,executor.userId,owner.userId,now).run();
  async function upload(actor=executor,name='报告.pdf') {
    const fileId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?4,'.pdf','available',?5,?6)").bind(fileId,projectId,actor.userId,`fixture/${fileId}`,name,new Date().toISOString()).run();
    return fileId;
  }
  async function request(path:string,method='GET',body?:unknown,actor=executor) {
    return SELF.fetch(`${BASE}/api/v1/projects/${projectId}/${path}`,{method,headers:{cookie:authCookie(actor.token),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  return {owner,executor,other,projectId,taskId,upload,request,path:`tasks/${taskId}/files`};
}
const data=async(response:Response)=>(await response.json() as {data:any}).data;
describe('任务文件版本及独立归档',()=>{
  it('registers idempotently, replaces immutable attachment snapshots and hides superseded files',async()=>{
    const f=await fixture(),firstFile=await f.upload();
    const created=await f.request(f.path,'POST',{fileId:firstFile});expect(created.status).toBe(201);
    const first=await data(created);expect(first).toMatchObject({fileId:firstFile,revision:1,canManage:true});
    const again=await data(await f.request(f.path,'POST',{fileId:firstFile}));expect(again.materialId).toBe(first.materialId);
    const secondFile=await f.upload(f.executor,'新版.pdf');
    const replaced=await f.request(`${f.path}/${first.materialId}`,'PUT',{fileId:secondFile,expectedRevision:1});expect(replaced.status).toBe(201);
    const second=await data(replaced);expect(second).toMatchObject({materialId:first.materialId,fileId:secondFile,revision:2});
    const retry=await data(await f.request(`${f.path}/${first.materialId}`,'PUT',{fileId:secondFile,expectedRevision:1}));expect(retry.versionId).toBe(second.versionId);
    expect((await f.request(`${f.path}/${first.materialId}`,'PUT',{fileId:firstFile,expectedRevision:2})).status).toBe(409);
    const history=await data(await f.request(`materials/${first.materialId}/versions/${first.versionId}`));expect(history.attachments[0].fileId).toBe(firstFile);
    const listed=await data(await f.request('files'));expect(listed.items.map((i:any)=>i.fileId)).toEqual([secondFile]);
    const taskList=await data(await f.request(f.path));expect(taskList.items).toHaveLength(1);
    const resources=await data(await f.request('resource-library'));expect(resources.items[0]).toMatchObject({fileId:secondFile,taskId:f.taskId,archivedAt:null,canManage:true});
    expect((await f.request(`${f.path}/${first.materialId}`,'PUT',{fileId:await f.upload(),expectedRevision:1})).status).toBe(409);
  });
  it('shares file archive across attachments, keeps material archive independent and rejects archived edits',async()=>{
    const f=await fixture(),fileId=await f.upload(),entry=await data(await f.request(f.path,'POST',{fileId}));
    expect((await f.request(`files/${fileId}/archive`,'POST',{expectedLifecycleVersion:1})).status).toBe(200);
    const task=await data(await f.request(f.path));expect(task.items[0].archivedAt).toBeTruthy();expect(task.items[0].materialArchivedAt).toBeNull();
    expect((await data(await f.request('resource-library'))).items).toHaveLength(0);
    expect((await data(await f.request('resource-library?archived=true'))).items).toHaveLength(1);
    const attachment=(await data(await f.request(`materials/${entry.materialId}`))).currentVersion.attachments[0];expect(attachment).toMatchObject({lifecycleVersion:2,canManage:true});expect(attachment.archivedAt).toBeTruthy();
    expect((await f.request(`files/${fileId}/unarchive`,'POST',{expectedLifecycleVersion:1})).status).toBe(409);
    expect((await f.request(`files/${fileId}/unarchive`,'POST',{expectedLifecycleVersion:2})).status).toBe(200);
    expect((await f.request(`materials/${entry.materialId}/archive`,'POST',{expectedRevision:1})).status).toBe(200);
    expect((await f.request(`${f.path}/${entry.materialId}`,'PUT',{fileId:await f.upload(),expectedRevision:2})).status).toBe(409);
    expect((await f.request(`resource-library/material/${entry.materialId}`,'PATCH',{purpose:'reference',expectedRevision:2})).status).toBe(409);
    expect((await data(await f.request('materials'))).items).toHaveLength(0);
    const archived=await data(await f.request('materials?archived=true'));expect(archived.items[0]).toMatchObject({taskId:f.taskId,canArchive:true,canEdit:false});
    expect((await f.request(`materials/${entry.materialId}/unarchive`,'POST',{expectedRevision:2})).status).toBe(200);
    expect((await data(await f.request(f.path))).items[0]).toMatchObject({revision:3,archivedAt:null,materialArchivedAt:null});
  });
  it('revokes former executor management and allows the current executor to manage existing uploads',async()=>{
    const f=await fixture(),fileId=await f.upload(),entry=await data(await f.request(f.path,'POST',{fileId}));
    await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(f.taskId,f.other.userId).run();
    expect((await f.request(`files/${fileId}/archive`,'POST',{expectedLifecycleVersion:1})).status).toBe(403);
    expect((await f.request(`files/${fileId}`,'DELETE',{expectedLifecycleVersion:1})).status).toBe(403);
    expect((await f.request(`materials/${entry.materialId}/archive`,'POST',{expectedRevision:1})).status).toBe(403);
    expect((await f.request(`${f.path}/${entry.materialId}`,'PUT',{fileId:await f.upload(),expectedRevision:1})).status).toBe(403);
    expect((await f.request(`files/${fileId}/archive`,'POST',{expectedLifecycleVersion:1},f.other)).status).toBe(200);
    expect((await data(await f.request(f.path,'GET',undefined,f.other))).items[0].canManage).toBe(true);
  });
  it('caps new task registrations at ten active entries and never claims an unavailable file',async()=>{
    const f=await fixture();
    for(let n=0;n<10;n++) expect((await f.request(f.path,'POST',{fileId:await f.upload()})).status).toBe(201);
    const overflow=await f.upload();expect((await f.request(f.path,'POST',{fileId:overflow})).status).toBe(409);
    expect((await env.DB.prepare('SELECT 1 FROM task_file_uploads WHERE file_id=?1').bind(overflow).first())).toBeNull();
    expect((await f.request(f.path,'POST',{fileId:crypto.randomUUID()})).status).toBe(404);
  });
  it('preserves public creator and uploader rights and keeps archived ordinary materials read-only',async()=>{
    const f=await fixture();
    const fileId=await f.upload();
    expect((await f.request(`files/${fileId}/archive`,'POST',{expectedLifecycleVersion:1},f.other)).status).toBe(403);
    expect((await f.request(`files/${fileId}/archive`,'POST',{expectedLifecycleVersion:1})).status).toBe(200);
    const created=await data(await f.request('materials','POST',{title:'公共材料'}));
    expect((await f.request(`materials/${created.materialId}/archive`,'POST',{expectedRevision:1})).status).toBe(200);
    expect((await f.request(`materials/${created.materialId}`,'PUT',{expectedRevision:2,doc:{type:'doc',content:[]}})).status).toBe(409);
    expect((await f.request(`resource-library/material/${created.materialId}`,'PATCH',{expectedRevision:2,purpose:'reference'})).status).toBe(409);
    expect((await f.request(`materials/${created.materialId}/unarchive`,'POST',{expectedRevision:2},f.other)).status).toBe(403);
    expect((await f.request(`materials/${created.materialId}/unarchive`,'POST',{expectedRevision:2})).status).toBe(200);
    expect((await f.request(`materials/${created.materialId}`,'PUT',{expectedRevision:3,doc:{type:'doc',content:[]}})).status).toBe(201);
    const result=await data(await f.request(`materials/${created.materialId}`));expect(result.revision).toBe(4);
  });
  it('rechecks executor rights inside the replacement transaction without leaving a version or mapping',async()=>{
    const f=await fixture(),entry=await data(await f.request(f.path,'POST',{fileId:await f.upload()})),replacement=await f.upload();
    const runtime={...env,DB:{prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
      await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(f.taskId,f.other.userId).run();
      return env.DB.batch(statements);
    }}} as unknown as Env;
    await expect(saveTaskFile(runtime,{projectId:f.projectId,taskId:f.taskId,actorId:f.executor.userId,fileId:replacement,materialId:entry.materialId,expectedRevision:1})).rejects.toThrow('已变化');
    expect(await env.DB.prepare('SELECT 1 FROM task_file_uploads WHERE file_id=?1').bind(replacement).first()).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM material_versions WHERE material_id=?1').bind(entry.materialId).first<{count:number}>())?.count).toBe(1);
    expect((await data(await f.request(f.path))).items[0]).toMatchObject({revision:1,fileId:entry.fileId,canManage:false});
  });
});
