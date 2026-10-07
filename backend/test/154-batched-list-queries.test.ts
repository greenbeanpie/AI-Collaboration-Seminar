import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { newId, nowIso } from '../src/core/db';
import { fileContributorsForFiles } from '../src/services/file-contributors';
import { readTaskFiles, saveTaskFile } from '../src/services/task-files';

function countedEnv() {
  const queries: string[]=[];
  const DB=new Proxy(env.DB,{get(target,key){
    if(key==='prepare') return (sql:string)=>{queries.push(sql);return target.prepare(sql);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return {bindings:{...env,DB},queries};
}

describe('batched list projections',()=>{
  it('loads file contributors in one query at any page size and isolates projects',async()=>{
    const user=await seedUser(),projectId=await seedProject(user.userId),foreign=await seedProject(user.userId);
    const ids:string[]=[];
    for(let i=0;i<20;i++){
      const id=newId();ids.push(id);
      await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES(?1,?2,?3,?1,'.pdf','available',?4)").bind(id,i===19?foreign:projectId,user.userId,nowIso()).run();
      await env.DB.prepare('INSERT INTO file_contributors(file_id,user_id,display_name) VALUES(?1,?2,?3)').bind(id,user.userId,'Snapshot name').run();
    }
    for(const size of [1,20]){
      const {bindings,queries}=countedEnv();
      const groups=await fileContributorsForFiles(bindings,projectId,ids.slice(0,size));
      expect(queries).toHaveLength(1);expect(groups.size).toBe(Math.min(size,19));
      expect(groups.get(ids[0]!)).toEqual([{userId:user.userId,displayName:'Snapshot name'}]);
    }
  });
  it('file list makes three projection queries for one or twenty rows',async()=>{
    const user=await seedUser(),projectId=await seedProject(user.userId);
    for(let i=0;i<20;i++) await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?1,'.pdf','available',?4,?5)").bind(newId(),projectId,user.userId,`File ${i}`,nowIso()).run();
    for(const size of [1,20]){
      const {bindings,queries}=countedEnv();
      const res=await createApp().request(`${BASE}/api/v1/projects/${projectId}/files?limit=${size}`,{headers:{cookie:authCookie(user.token)}},bindings);
      expect(res.status).toBe(200);expect((await res.json() as any).data.items).toHaveLength(size);
      expect(queries.filter(sql=>sql.includes('FROM files WHERE')||sql.includes('FROM file_contributors')||sql.includes('SELECT DISTINCT f.id fileId'))).toHaveLength(3);
    }
  });
  it('task files retain per-actor permissions and archived records in one projection query',async()=>{
    const owner=await seedUser(),reader=await seedUser(),projectId=await seedProject(owner.userId),taskId=newId();
    await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,assignee_id,created_by,created_at,updated_at) VALUES(?1,?2,'Task','','todo',?3,?3,?4,?4)").bind(taskId,projectId,owner.userId,nowIso()).run();
    for(let i=0;i<3;i++){
      const id=newId();await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?1,'.pdf','available','Report',?4)").bind(id,projectId,owner.userId,nowIso()).run();
      await saveTaskFile(env,{projectId,taskId,actorId:owner.userId,fileId:id});
    }
    const {bindings,queries}=countedEnv();
    const rows=await readTaskFiles(bindings,projectId,taskId,reader.userId);
    expect(queries).toHaveLength(1);expect(rows).toHaveLength(3);expect(rows.every(row=>!row.canManage)).toBe(true);
    expect(await readTaskFiles(bindings,newId(),taskId,owner.userId)).toEqual([]);
  });
  it('loads private inquiry messages in a single query for one or twenty threads',async()=>{
    const user=await seedUser(),other=await seedUser(),outsider=await seedUser(),projectId=await seedProject(user.userId),taskId=newId();
    await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),projectId,other.userId,nowIso()).run();
    await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,created_by,created_at,updated_at) VALUES(?1,?2,'Task','','todo',?3,?4,?4)").bind(taskId,projectId,user.userId,nowIso()).run();
    for(let i=0;i<20;i++){
      const id=newId();await env.DB.prepare("INSERT INTO task_inquiries(id,project_id,task_id,upstream_task_id,requester_id,recipient_id,recipient_source,task_title,upstream_title,created_at) VALUES(?1,?2,?3,?3,?4,?5,'substitute','Task','Task',?6)").bind(id,projectId,taskId,user.userId,other.userId,nowIso()).run();
      await env.DB.prepare("INSERT INTO task_inquiry_messages(id,inquiry_id,author_id,body,created_at) VALUES(?1,?2,?3,'Private body',?4)").bind(newId(),id,user.userId,nowIso()).run();
    }
    for(const size of [1,20]){
      const {bindings,queries}=countedEnv();
      const res=await createApp().request(`${BASE}/api/v1/projects/${projectId}/tasks/${taskId}/inquiries?limit=${size}`,{headers:{cookie:authCookie(user.token)}},bindings);
      expect(res.status).toBe(200);const data=(await res.json() as any).data;
      expect(data.items).toHaveLength(size);expect(data.items.every((item:any)=>item.messages.length===1)).toBe(true);
      expect(queries.filter(sql=>sql.includes('FROM task_inquiry_messages'))).toHaveLength(1);
    }
    const rejected=await createApp().request(`${BASE}/api/v1/projects/${projectId}/tasks/${taskId}/inquiries`,{headers:{cookie:authCookie(outsider.token)}},env);
    expect(rejected.status).toBe(403);
  });

  it('source list contributors use one batch query and tolerate a missing file',async()=>{
    const user=await seedUser(),projectId=await seedProject(user.userId);
    for(let i=0;i<20;i++){
      const fileId=newId(),sourceId=newId(),versionId=newId(),now=nowIso();
      await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES(?1,?2,?3,?1,'.pdf','available',?4)").bind(fileId,projectId,user.userId,now).run();
      await env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at,current_version_id) VALUES(?1,?2,'file','Source',?3,?4,?4,?5)").bind(sourceId,projectId,user.userId,now,versionId).run();
      await env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,created_at) VALUES(?1,?2,?3,1,'file',?4,?5)").bind(versionId,sourceId,projectId,fileId,now).run();
    }
    for(const size of [1,20]){
      const {bindings,queries}=countedEnv();const res=await createApp().request(`${BASE}/api/v1/projects/${projectId}/sources?limit=${size}`,{headers:{cookie:authCookie(user.token)}},bindings);
      expect(res.status).toBe(200);expect((await res.json() as any).data.items).toHaveLength(size);
      expect(queries.filter(sql=>sql.includes('FROM file_contributors'))).toHaveLength(1);
    }
  });

});
